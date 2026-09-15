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

/** A one-letter "last name" is an initial (thom.v@), not a name. */
const usable = (s: string | null | undefined) => !!s && s.trim().length > 1;

/**
 * steven@scale8it.nl next to steven.kasper@scale8it.nl: the same person on
 * the same domain, so the sibling's last name is the best available guess.
 */
function siblingLastName(account: Pick<Account, 'id' | 'email'>, firstName: string): string | null {
  const domain = account.email.split('@')[1];
  if (!domain) return null;
  const rows = db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.orgId, orgIdOf(account.id) ?? ''))
    .all()
    .filter((a) => a.id !== account.id && a.email.endsWith('@' + domain));
  for (const a of rows) {
    const n = namesFor(a, false);
    if (n.firstName.toLowerCase() === firstName.toLowerCase() && usable(n.lastName)) return n.lastName;
  }
  return null;
}

function orgIdOf(accountId: string): string | null {
  return db.select({ orgId: schema.accounts.orgId }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).get()?.orgId ?? null;
}

/** Names for exports: stored first, then the display name, then a guess
 *  from the address (the same guess the warmup persona uses), completed
 *  with a sibling mailbox's last name when the address only has an initial. */
export function namesFor(
  account: Pick<Account, 'id' | 'email' | 'displayName' | 'firstName' | 'lastName'>,
  lookAtSiblings = true,
): AccountNames {
  const stored = { first: account.firstName?.trim() ?? '', last: account.lastName?.trim() ?? '' };
  const display = account.displayName?.trim() ?? '';
  // The guess, used whole when nothing is stored and to complete a half-set name.
  const guess = (): { first: string; last: string } => {
    if (display && !display.includes('@')) {
      const parts = display.split(/\s+/);
      return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
    }
    const persona = derivePersona(account);
    let last = usable(persona.lastName) ? persona.lastName! : '';
    if (!last && lookAtSiblings) last = siblingLastName(account, persona.firstName) ?? '';
    return { first: persona.firstName, last };
  };
  if (stored.first || stored.last) {
    const g = stored.first && stored.last ? null : guess();
    const firstName = stored.first || g?.first || '';
    const lastName = stored.last || g?.last || '';
    return {
      displayName: display || [firstName, lastName].filter(Boolean).join(' '),
      firstName,
      lastName,
      source: 'account',
    };
  }
  const g = guess();
  return {
    displayName: display && !display.includes('@') ? display : [g.first, g.last].filter(Boolean).join(' '),
    firstName: g.first,
    lastName: g.last,
    source: display && !display.includes('@') ? 'account' : 'derived',
  };
}

/** Set the same name on many mailboxes (a persona spread over several domains). */
export function setNamesOnAccounts(accountIds: string[], names: { firstName?: string | null; lastName?: string | null }): number {
  let n = 0;
  for (const id of accountIds) {
    setAccountNames(id, names);
    n++;
  }
  return n;
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
