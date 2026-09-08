/**
 * Warmup account state machine. Every transition lives here so "why is this
 * mailbox not warming" is answered by reading one file.
 *
 *   off → ramping → steady
 *   ramping/steady ⇄ paused (a person)          keeps ramp day
 *   ramping/steady ⇄ auto_paused (reputation)   lifts itself after cooldown
 *   any enabled state ⇄ blocked_upstream        mirrors accounts.status
 */

import { eq, and, ne, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { logger } from '../logger.js';
import { logActivity } from '../observability/activity.js';
import { ensureOrgTag } from './identity.js';
import { cancelPendingTasks } from './tasks.js';
import { derivePersona, parsePersona, type Persona } from './content/persona.js';
import { emitWarmupEvent } from './events.js';
import type { Account, WarmupAccount } from '../db/schema.js';

export type WarmupState = WarmupAccount['state'];

export function getWarmupAccount(accountId: string): WarmupAccount | undefined {
  return db
    .select()
    .from(schema.warmupAccounts)
    .where(eq(schema.warmupAccounts.accountId, accountId))
    .get();
}

export function ensureWarmupRow(accountId: string): WarmupAccount {
  const existing = getWarmupAccount(accountId);
  if (existing) return existing;
  const now = Date.now();
  db.insert(schema.warmupAccounts)
    .values({ accountId, enabled: 0, state: 'off', createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
  return getWarmupAccount(accountId)!;
}

function loadAccount(accountId: string): Account {
  const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
  if (!account) throw new Error(`Unknown account ${accountId}`);
  return account;
}

function setState(accountId: string, patch: Partial<WarmupAccount>): WarmupAccount {
  db.update(schema.warmupAccounts)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(schema.warmupAccounts.accountId, accountId))
    .run();
  return getWarmupAccount(accountId)!;
}

export function personaFor(account: Account, warm?: WarmupAccount | null): Persona {
  return parsePersona(warm?.personaJson, derivePersona(account));
}

export function setPersona(accountId: string, persona: Partial<Persona>): WarmupAccount {
  ensureWarmupRow(accountId);
  const account = loadAccount(accountId);
  const current = personaFor(account, getWarmupAccount(accountId));
  const merged: Persona = {
    firstName: (persona.firstName ?? current.firstName).trim() || current.firstName,
    lastName: persona.lastName === undefined ? current.lastName : persona.lastName?.trim() || null,
    role: persona.role === undefined ? current.role : persona.role?.trim() || null,
    company: persona.company === undefined ? current.company : persona.company?.trim() || null,
    signOff: persona.signOff === undefined ? current.signOff : persona.signOff?.trim() || null,
  };
  return setState(accountId, { personaJson: JSON.stringify(merged) });
}

/** Opt a mailbox into the pool. Idempotent. */
export function enableWarmup(accountId: string): WarmupAccount {
  const account = loadAccount(accountId);
  const row = ensureWarmupRow(accountId);
  ensureOrgTag(account.orgId);
  if (row.enabled && row.state !== 'off') return row;
  const now = Date.now();
  const state: WarmupState = account.status === 'active' ? 'ramping' : 'blocked_upstream';
  const updated = setState(accountId, {
    enabled: 1,
    state,
    startedAt: row.startedAt ?? now,
    pausedUntil: null,
    pauseReason: state === 'blocked_upstream' ? `upstream:ramping` : null,
    personaJson: row.personaJson ?? JSON.stringify(derivePersona(account)),
    // Re-plan today immediately.
    lastPlannedDate: null,
  });
  logActivity({ category: 'warmup', action: 'enable', status: 'ok', accountId, detail: `state=${state}` });
  emitWarmupEvent(account, 'warmup.enabled', { state });
  return updated;
}

/** Leave the pool. Pending work is dropped; history is kept. */
export function disableWarmup(accountId: string): WarmupAccount {
  const account = loadAccount(accountId);
  ensureWarmupRow(accountId);
  const cancelled = cancelPendingTasks(accountId, 'Warmup disabled');
  const updated = setState(accountId, {
    enabled: 0,
    state: 'off',
    pausedUntil: null,
    pauseReason: null,
    todayTarget: 0,
  });
  logActivity({
    category: 'warmup',
    action: 'disable',
    status: 'ok',
    accountId,
    detail: cancelled ? `${cancelled} pending task(s) dropped` : undefined,
  });
  emitWarmupEvent(account, 'warmup.disabled', {});
  return updated;
}

/** A person pauses sending. Engagement with mail already received continues;
 *  new conversations stop. */
export function pauseWarmup(accountId: string, reason = 'Paused'): WarmupAccount {
  const account = loadAccount(accountId);
  const row = ensureWarmupRow(accountId);
  if (!row.enabled) return row;
  cancelPendingTasks(accountId, reason, ['send_open', 'send_forward']);
  const updated = setState(accountId, { state: 'paused', pauseReason: reason, pausedUntil: null });
  logActivity({ category: 'warmup', action: 'pause', status: 'ok', accountId, detail: reason });
  emitWarmupEvent(account, 'warmup.paused', { reason, by: 'user' });
  return updated;
}

export function resumeWarmup(accountId: string): WarmupAccount {
  const account = loadAccount(accountId);
  const row = ensureWarmupRow(accountId);
  if (!row.enabled) return enableWarmup(accountId);
  if (row.state !== 'paused' && row.state !== 'auto_paused') return row;
  const state: WarmupState = account.status === 'active' ? 'ramping' : 'blocked_upstream';
  const updated = setState(accountId, {
    state,
    pauseReason: state === 'blocked_upstream' ? 'upstream:ramping' : null,
    pausedUntil: null,
    lastPlannedDate: null,
  });
  logActivity({ category: 'warmup', action: 'resume', status: 'ok', accountId });
  emitWarmupEvent(account, 'warmup.resumed', { by: 'user' });
  return updated;
}

/** Reputation controller: pause for a cooldown, then come back at half volume. */
export function autoPauseWarmup(accountId: string, reason: string, cooldownDays: number): WarmupAccount {
  const account = loadAccount(accountId);
  cancelPendingTasks(accountId, reason, ['send_open', 'send_forward']);
  const updated = setState(accountId, {
    state: 'auto_paused',
    pauseReason: reason,
    pausedUntil: Date.now() + cooldownDays * 24 * 3600_000,
    throttlePercent: 50,
    cleanDays: 0,
    todayTarget: 0,
  });
  logActivity({ category: 'warmup', action: 'auto-pause', status: 'failed', accountId, error: reason });
  emitWarmupEvent(account, 'warmup.paused', { reason, by: 'reputation', until: updated.pausedUntil });
  return updated;
}

/**
 * Mirror upstream account status into warmup state, lift expired
 * auto-pauses. Called by the planner tick, so it runs every minute.
 */
export function syncUpstreamState(now = Date.now()): void {
  const rows = db
    .select({ warm: schema.warmupAccounts, account: schema.accounts })
    .from(schema.warmupAccounts)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.warmupAccounts.accountId))
    .where(and(eq(schema.warmupAccounts.enabled, 1), ne(schema.warmupAccounts.state, 'off')))
    .all();
  for (const { warm, account } of rows) {
    if (account.status !== 'active') {
      if (warm.state !== 'blocked_upstream' && warm.state !== 'paused') {
        cancelPendingTasks(account.id, `Account is ${account.status}`);
        setState(account.id, { state: 'blocked_upstream', pauseReason: `upstream:${warm.state}` });
        logActivity({
          category: 'warmup',
          action: 'blocked-upstream',
          status: 'failed',
          accountId: account.id,
          error: `Account is ${account.status}; warmup waits until it is active again`,
        });
      }
      continue;
    }
    if (warm.state === 'blocked_upstream') {
      const previous = (warm.pauseReason ?? '').replace(/^upstream:/, '') as WarmupState;
      const restored: WarmupState = previous === 'steady' ? 'steady' : 'ramping';
      setState(account.id, { state: restored, pauseReason: null, lastPlannedDate: null });
      logActivity({ category: 'warmup', action: 'unblocked', status: 'ok', accountId: account.id });
      continue;
    }
    if (warm.state === 'auto_paused' && warm.pausedUntil && warm.pausedUntil <= now) {
      setState(account.id, { state: 'ramping', pauseReason: null, pausedUntil: null, lastPlannedDate: null });
      logActivity({
        category: 'warmup',
        action: 'auto-resume',
        status: 'ok',
        accountId: account.id,
        detail: 'cooldown over; resuming at half volume',
      });
      emitWarmupEvent(account, 'warmup.resumed', { by: 'reputation' });
    }
  }
}

/** Bulk state change for a set of accounts; returns per-account results. */
export function bulkWarmupAction(
  accountIds: string[],
  action: 'enable' | 'disable' | 'pause' | 'resume',
): { accountId: string; ok: boolean; error?: string }[] {
  const results: { accountId: string; ok: boolean; error?: string }[] = [];
  for (const accountId of accountIds) {
    try {
      if (action === 'enable') enableWarmup(accountId);
      else if (action === 'disable') disableWarmup(accountId);
      else if (action === 'pause') pauseWarmup(accountId);
      else resumeWarmup(accountId);
      results.push({ accountId, ok: true });
    } catch (err) {
      logger.warn({ accountId, action, err: String(err) }, 'bulk warmup action failed');
      results.push({ accountId, ok: false, error: String(err) });
    }
  }
  return results;
}

export function warmupRowsForOrg(orgId: string): WarmupAccount[] {
  const ids = db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.orgId, orgId))
    .all()
    .map((r) => r.id);
  if (ids.length === 0) return [];
  return db.select().from(schema.warmupAccounts).where(inArray(schema.warmupAccounts.accountId, ids)).all();
}
