/**
 * The pool: every opted-in mailbox on the instance, and how partners are
 * chosen for a conversation. Selection is a weighted random draw from the
 * eligible set; the weights push traffic across domains and providers,
 * toward trusted "mentor" mailboxes, and away from pairs that already talk.
 */

import { eq, sql } from 'drizzle-orm';
import { db, sqlite, schema } from '../db/index.js';
import { config } from '../config.js';
import { providerFor } from '../providers/index.js';
import { accountGrantedScopes } from '../imap/index-store.js';
import { resolveWarmupSettings, effectiveReceiveLimit, type WarmupSettings } from './settings.js';
import { localDate, localToInstant, shiftDate } from './clock.js';
import { plannedInboundCount } from './tasks.js';
import { derivePersona, parsePersona, fullName } from './content/persona.js';
import type { Rng } from './rng.js';
import type { Account, Org, WarmupAccount } from '../db/schema.js';

export interface PoolMember {
  account: Account;
  warm: WarmupAccount;
  org: Org;
  settings: WarmupSettings;
  domain: string;
  canWrite: boolean;
  polledRecently: boolean;
  /** 7-day inbox placement as a sender, null with fewer than 10 samples. */
  inboxRate7d: number | null;
  /** Persona full name, lowercased: a person should not email themselves. */
  personaName: string;
}

export function domainOf(email: string): string {
  return (email.split('@')[1] ?? '').toLowerCase();
}

/** Every enabled warmup mailbox, regardless of state (the caller filters). */
export function loadPool(): PoolMember[] {
  const rows = db
    .select({ account: schema.accounts, warm: schema.warmupAccounts, org: schema.orgs })
    .from(schema.warmupAccounts)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.warmupAccounts.accountId))
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.accounts.orgId))
    .where(eq(schema.warmupAccounts.enabled, 1))
    .all();
  const since = Date.now() - 2 * 3600_000;
  return rows.map(({ account, warm, org }) => {
    const sync = db
      .select({ lastPolledAt: schema.syncState.lastPolledAt, lastError: schema.syncState.lastError })
      .from(schema.syncState)
      .where(eq(schema.syncState.accountId, account.id))
      .get();
    return {
      account,
      warm,
      org,
      settings: resolveWarmupSettings(org, warm).settings,
      domain: domainOf(account.email),
      canWrite: providerFor(account.provider).supportsWrite(accountGrantedScopes(account.id)),
      polledRecently:
        (sync?.lastPolledAt ?? 0) > since || account.createdAt > Date.now() - 3600_000,
      inboxRate7d: senderInboxRate(account.id, 7),
      personaName: fullName(parsePersona(warm.personaJson, derivePersona(account))).toLowerCase(),
    };
  });
}

/** One member by account id (null when not opted in). */
export function loadMember(accountId: string): PoolMember | null {
  return loadPool().find((m) => m.account.id === accountId) ?? null;
}

export interface PlacementCounts {
  inbox: number;
  spam: number;
  category: number;
  missing: number;
  bounced: number;
  pending: number;
  total: number;
}

/** Placement of what this mailbox SENT in the last `days` days. */
export function senderPlacement(accountId: string, days: number): PlacementCounts {
  const since = Date.now() - days * 24 * 3600_000;
  const row = sqlite
    .prepare(
      `SELECT
         COALESCE(SUM(landed = 'inbox'), 0) AS inbox,
         COALESCE(SUM(landed = 'spam'), 0) AS spam,
         COALESCE(SUM(landed IN ('promotions','social','updates','forums','other')), 0) AS category,
         COALESCE(SUM(landed = 'missing'), 0) AS missing,
         COALESCE(SUM(landed = 'bounced'), 0) AS bounced,
         COALESCE(SUM(landed IS NULL), 0) AS pending,
         COUNT(*) AS total
       FROM warmup_landings WHERE from_account_id = ? AND created_at > ?`,
    )
    .get(accountId, since) as PlacementCounts;
  return row;
}

export function senderInboxRate(accountId: string, days: number): number | null {
  const p = senderPlacement(accountId, days);
  const decided = p.inbox + p.spam + p.category + p.missing;
  if (decided < 10) return null;
  return ((p.inbox + p.category) / decided) * 100;
}

/** Spam + missing share of decided placements, the number the throttle uses. */
export function senderSpamRate(accountId: string, days: number): { rate: number | null; samples: number } {
  const p = senderPlacement(accountId, days);
  const decided = p.inbox + p.spam + p.category + p.missing;
  if (decided === 0) return { rate: null, samples: 0 };
  return { rate: ((p.spam + p.missing) / decided) * 100, samples: decided };
}

/** Messages exchanged between two mailboxes in the last 7 days. */
function pairCount(a: string, b: string): number {
  const since = Date.now() - 7 * 24 * 3600_000;
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM warmup_messages
       WHERE kind IN ('open','forward') AND created_at > ?
         AND ((from_account_id = ? AND to_account_id = ?) OR (from_account_id = ? AND to_account_id = ?))`,
    )
    .get(since, a, b, b, a) as { n: number };
  return row.n;
}

/** Warmup mail already received today (recipient-local) plus what is planned. */
export function inboundLoadToday(member: PoolMember, now = Date.now()): { received: number; planned: number; limit: number } {
  const tz = member.settings.timezone;
  const today = localDate(now, tz);
  const dayStart = localToInstant(today, 0, tz);
  const dayEnd = localToInstant(shiftDate(today, 1), 0, tz);
  const received = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM warmup_landings WHERE to_account_id = ? AND created_at >= ? AND created_at < ?`,
      )
      .get(member.account.id, dayStart, dayEnd) as { n: number }
  ).n;
  const planned = plannedInboundCount(member.account.id, dayStart, dayEnd);
  return { received, planned, limit: effectiveReceiveLimit(member.settings) };
}

export function poolScopeAllows(a: PoolMember, b: PoolMember): boolean {
  if (a.org.id === b.org.id) return true;
  return a.org.warmupPoolScope === 'instance' && b.org.warmupPoolScope === 'instance';
}

export function sharedLanguages(a: PoolMember, b: PoolMember): string[] {
  return a.settings.languages.filter((l) => b.settings.languages.includes(l));
}

export interface PartnerQuery {
  /** Same-domain (falls back to same-org) conversation. */
  internal: boolean;
  /** Accounts that must not be chosen (already on the thread). */
  exclude?: Set<string>;
  now?: number;
}

const RECEIVER_STATES = new Set(['ramping', 'steady', 'auto_paused']);

export function eligiblePartners(sender: PoolMember, pool: PoolMember[], q: PartnerQuery): PoolMember[] {
  const now = q.now ?? Date.now();
  return pool.filter((c) => {
    if (c.account.id === sender.account.id) return false;
    if (q.exclude?.has(c.account.id)) return false;
    if (c.account.status !== 'active') return false;
    if (!RECEIVER_STATES.has(c.warm.state)) return false;
    if (!c.polledRecently) return false;
    if (!poolScopeAllows(sender, c)) return false;
    if (sharedLanguages(sender, c).length === 0) return false;
    const sameDomain = c.domain === sender.domain;
    const sameOrg = c.org.id === sender.org.id;
    if (q.internal) {
      if (!sameDomain && !sameOrg) return false;
      if (sameDomain && !sender.settings.allowSameDomain) return false;
    } else {
      if (sameDomain && !sender.settings.allowSameDomain) return false;
    }
    if (sameOrg && !sender.settings.allowSameOrg && !q.internal) return false;
    const load = inboundLoadToday(c, now);
    if (load.received + load.planned >= load.limit) return false;
    return true;
  });
}

export function partnerWeight(sender: PoolMember, c: PoolMember, q: PartnerQuery): number {
  // The same person at two of their own domains does not write to themselves.
  if (c.personaName && c.personaName === sender.personaName) return 0;
  let w = 1;
  const sameDomain = c.domain === sender.domain;
  if (q.internal) {
    // Prefer genuinely same-domain "colleagues" over same-org other-domain.
    w *= sameDomain ? 3 : 1;
  } else {
    w *= sameDomain ? 0.15 : 3;
    if (sender.settings.preferCrossProvider && c.account.provider !== sender.account.provider) w *= 2;
  }
  if (c.warm.state === 'steady' && (c.inboxRate7d ?? 0) >= 95) w *= 1.8;
  const pairs = pairCount(sender.account.id, c.account.id);
  if (pairs >= 4) return 0;
  w *= Math.pow(0.4, pairs);
  const load = inboundLoadToday(c, q.now);
  w *= Math.max(0.05, (load.limit - load.received - load.planned) / load.limit);
  if (!c.canWrite) w *= 0.5;
  return w;
}

export function choosePartner(sender: PoolMember, pool: PoolMember[], rng: Rng, q: PartnerQuery): PoolMember | null {
  let candidates = eligiblePartners(sender, pool, q);
  if (candidates.length === 0 && q.internal) {
    // No colleague available today: fall back to an external partner rather
    // than losing the slot.
    candidates = eligiblePartners(sender, pool, { ...q, internal: false });
    if (candidates.length === 0) return null;
    return rng.weighted(candidates, (c) => partnerWeight(sender, c, { ...q, internal: false })) ?? null;
  }
  if (candidates.length === 0) return null;
  return rng.weighted(candidates, (c) => partnerWeight(sender, c, q)) ?? null;
}

/** Pool members that may currently send new conversations. */
export function activeSenders(pool: PoolMember[]): PoolMember[] {
  return pool.filter(
    (m) => m.account.status === 'active' && (m.warm.state === 'ramping' || m.warm.state === 'steady'),
  );
}

export function poolSize(pool: PoolMember[]): number {
  return pool.filter((m) => m.account.status === 'active' && RECEIVER_STATES.has(m.warm.state)).length;
}

export function poolTooSmall(pool: PoolMember[]): boolean {
  return poolSize(pool) < config.WARMUP_MIN_POOL_SIZE;
}

export function memberById(pool: PoolMember[], accountId: string): PoolMember | undefined {
  return pool.find((m) => m.account.id === accountId);
}

/** Count of warmup messages this account sent on a sender-local date. */
export function sentOnDate(accountId: string, date: string): number {
  return db
    .select({ n: sql<number>`count(*)` })
    .from(schema.warmupMessages)
    .where(
      sql`${schema.warmupMessages.fromAccountId} = ${accountId} AND ${schema.warmupMessages.localDate} = ${date} AND ${schema.warmupMessages.sentAt} IS NOT NULL`,
    )
    .get()!.n;
}

/** Warmup messages created (queued or sent) on a sender-local date — the
 *  number the daily cap is enforced against. */
export function createdOnDate(accountId: string, date: string): number {
  return db
    .select({ n: sql<number>`count(*)` })
    .from(schema.warmupMessages)
    .where(
      sql`${schema.warmupMessages.fromAccountId} = ${accountId} AND ${schema.warmupMessages.localDate} = ${date} AND ${schema.warmupMessages.failedAt} IS NULL AND ${schema.warmupMessages.kind} != 'mdn'`,
    )
    .get()!.n;
}
