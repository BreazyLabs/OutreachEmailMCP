/**
 * The person behind a mailbox: display name, first and last name. Sequencers
 * import these next to the credentials (Instantly refuses a row without
 * both names), so they are stored on the account, filled from the provider
 * at connect time or on demand, and editable by hand.
 */

import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { providerFor } from '../providers/index.js';
import { derivePersona } from '../warmup/content/persona.js';
import { logger } from '../logger.js';
import type { Account } from '../db/schema.js';

export interface AccountNames {
  displayName: string;
  firstName: string;
  lastName: string;
  /** Where the names came from: stored on the account, or guessed. */
  source: 'account' | 'derived';
}

/** Names for exports: stored first, then the display name, then a guess
 *  from the address (the same guess the warmup persona uses). */
export function namesFor(account: Pick<Account, 'id' | 'email' | 'displayName' | 'firstName' | 'lastName'>): AccountNames {
  const stored = { first: account.firstName?.trim() ?? '', last: account.lastName?.trim() ?? '' };
  const display = account.displayName?.trim() ?? '';
  if (stored.first || stored.last) {
    return {
      displayName: display || [stored.first, stored.last].filter(Boolean).join(' '),
      firstName: stored.first,
      lastName: stored.last,
      source: 'account',
    };
  }
  if (display && !display.includes('@')) {
    const parts = display.split(/\s+/);
    return { displayName: display, firstName: parts[0] ?? '', lastName: parts.slice(1).join(' '), source: 'account' };
  }
  const persona = derivePersona(account);
  return {
    displayName: [persona.firstName, persona.lastName].filter(Boolean).join(' '),
    firstName: persona.firstName,
    lastName: persona.lastName ?? '',
    source: 'derived',
  };
}

export function setAccountNames(
  accountId: string,
  names: { firstName?: string | null; lastName?: string | null; displayName?: string | null },
): void {
  const patch: Partial<typeof schema.accounts.$inferInsert> = { updatedAt: Date.now() };
  if (names.firstName !== undefined) patch.firstName = names.firstName?.trim() || null;
  if (names.lastName !== undefined) patch.lastName = names.lastName?.trim() || null;
  if (names.displayName !== undefined) patch.displayName = names.displayName?.trim() || null;
  db.update(schema.accounts).set(patch).where(eq(schema.accounts.id, accountId)).run();
}

/** Ask the provider for the mailbox owner's name and store what it knows.
 *  Returns what was stored, or null when the provider had nothing. */
export async function refreshAccountProfile(accountId: string): Promise<{ displayName: string | null; firstName: string | null; lastName: string | null } | null> {
  const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
  if (!account) return null;
  const profile = await providerFor(account.provider).fetchProfile(account.id);
  if (!profile.displayName && !profile.firstName && !profile.lastName) return null;
  const patch: Partial<typeof schema.accounts.$inferInsert> = { updatedAt: Date.now() };
  if (profile.displayName) patch.displayName = profile.displayName;
  if (profile.firstName) patch.firstName = profile.firstName;
  if (profile.lastName) patch.lastName = profile.lastName;
  db.update(schema.accounts).set(patch).where(eq(schema.accounts.id, accountId)).run();
  return { displayName: profile.displayName, firstName: profile.firstName, lastName: profile.lastName };
}

/** Refresh many mailboxes, one after another; a failure on one does not
 *  stop the rest. */
export async function refreshAccountProfiles(
  orgId: string,
  accountIds?: string[],
): Promise<{ accountId: string; email: string; ok: boolean; names?: string; error?: string }[]> {
  let accounts = db.select().from(schema.accounts).where(eq(schema.accounts.orgId, orgId)).all();
  if (accountIds) {
    const wanted = new Set(accountIds);
    accounts = accounts.filter((a) => wanted.has(a.id));
  }
  const out: { accountId: string; email: string; ok: boolean; names?: string; error?: string }[] = [];
  for (const a of accounts) {
    if (a.status === 'disabled') {
      out.push({ accountId: a.id, email: a.email, ok: false, error: 'Account is disabled' });
      continue;
    }
    try {
      const r = await refreshAccountProfile(a.id);
      out.push({
        accountId: a.id,
        email: a.email,
        ok: true,
        names: r ? [r.firstName, r.lastName].filter(Boolean).join(' ') || r.displayName || '' : '',
      });
    } catch (err) {
      logger.warn({ account: a.email, err: String(err) }, 'profile refresh failed');
      out.push({ accountId: a.id, email: a.email, ok: false, error: String(err).slice(0, 200) });
    }
  }
  return out;
}

/** Accounts whose export row would lack a last name (Instantly rejects those). */
export function accountsMissingNames(orgId: string): { id: string; email: string }[] {
  return db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.orgId, orgId))
    .all()
    .filter((a) => a.status !== 'disabled')
    .filter((a) => {
      const n = namesFor(a);
      return !n.firstName || !n.lastName;
    })
    .map((a) => ({ id: a.id, email: a.email }));
}

export function accountsByIds(orgId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(schema.accounts)
    .where(inArray(schema.accounts.id, ids))
    .all()
    .filter((a) => a.orgId === orgId);
}
