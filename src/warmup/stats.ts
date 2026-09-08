/**
 * Read models for the dashboard, the API and the health check. Everything
 * is derived from the ledger (warmup_messages + warmup_landings) and the
 * task queue; nothing here writes.
 */

import { eq, desc, and, inArray } from 'drizzle-orm';
import { db, sqlite, schema } from '../db/index.js';
import { config } from '../config.js';
import { providerFor } from '../providers/index.js';
import { accountGrantedScopes } from '../imap/index-store.js';
import { resolveWarmupSettings, effectiveReceiveLimit, type ResolvedWarmupSettings } from './settings.js';
import { senderPlacement, type PlacementCounts } from './pool.js';
import { localDate, localToInstant, shiftDate } from './clock.js';
import { personaFor, getWarmupAccount } from './state.js';
import { contentSourceMix } from './content/scripts.js';
import { llmStatus } from './content/llm.js';
import type { Persona } from './content/persona.js';
import type { Account, Org, WarmupAccount } from '../db/schema.js';

export interface AccountWarmupSummary {
  accountId: string;
  email: string;
  provider: string;
  accountStatus: string;
  enabled: boolean;
  state: WarmupAccount['state'];
  rampDay: number;
  startedAt: number | null;
  todayTarget: number;
  todaySent: number;
  todayReceived: number;
  receiveLimit: number;
  dailyLimit: number;
  placement7d: PlacementCounts;
  inboxRate7d: number | null;
  spamRate7d: number | null;
  rescued7d: number;
  repliesSent7d: number;
  forwards7d: number;
  receipts7d: number;
  throttlePercent: number;
  pauseReason: string | null;
  pausedUntil: number | null;
  canWrite: boolean;
  pendingTasks: number;
  lastEvent: { action: string; status: string; detail: string | null; at: number } | null;
  timezone: string;
}

function countWhere(sqlText: string, ...params: unknown[]): number {
  return (sqlite.prepare(sqlText).get(...params) as { n: number }).n;
}

export function summarizeAccount(account: Account, org: Org, warm: WarmupAccount | undefined): AccountWarmupSummary {
  const { settings } = resolveWarmupSettings(org, warm);
  const tz = settings.timezone;
  const today = localDate(Date.now(), tz);
  const dayStart = localToInstant(today, 0, tz);
  const dayEnd = localToInstant(shiftDate(today, 1), 0, tz);
  const since7 = Date.now() - 7 * 24 * 3600_000;
  const placement = senderPlacement(account.id, 7);
  const decided = placement.inbox + placement.spam + placement.category + placement.missing;
  const lastEvent = db
    .select({
      action: schema.activityLog.action,
      status: schema.activityLog.status,
      detail: schema.activityLog.detail,
      at: schema.activityLog.createdAt,
    })
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.accountId, account.id), eq(schema.activityLog.category, 'warmup')))
    .orderBy(desc(schema.activityLog.createdAt))
    .limit(1)
    .get();
  return {
    accountId: account.id,
    email: account.email,
    provider: account.provider,
    accountStatus: account.status,
    enabled: !!warm?.enabled,
    state: warm?.state ?? 'off',
    rampDay: warm?.rampDay ?? 0,
    startedAt: warm?.startedAt ?? null,
    todayTarget: warm?.todayTarget ?? 0,
    todaySent: countWhere(
      `SELECT COUNT(*) AS n FROM warmup_messages WHERE from_account_id = ? AND local_date = ? AND sent_at IS NOT NULL AND kind != 'mdn'`,
      account.id,
      today,
    ),
    todayReceived: countWhere(
      `SELECT COUNT(*) AS n FROM warmup_landings WHERE to_account_id = ? AND created_at >= ? AND created_at < ?`,
      account.id,
      dayStart,
      dayEnd,
    ),
    receiveLimit: effectiveReceiveLimit(settings),
    dailyLimit: settings.dailyLimit,
    placement7d: placement,
    inboxRate7d: decided >= 1 ? Math.round(((placement.inbox + placement.category) / decided) * 1000) / 10 : null,
    spamRate7d: decided >= 1 ? Math.round(((placement.spam + placement.missing) / decided) * 1000) / 10 : null,
    rescued7d: countWhere(
      `SELECT COUNT(*) AS n FROM warmup_landings WHERE from_account_id = ? AND rescued_at > ?`,
      account.id,
      since7,
    ),
    repliesSent7d: countWhere(
      `SELECT COUNT(*) AS n FROM warmup_messages WHERE from_account_id = ? AND kind = 'reply' AND created_at > ?`,
      account.id,
      since7,
    ),
    forwards7d: countWhere(
      `SELECT COUNT(*) AS n FROM warmup_messages WHERE from_account_id = ? AND kind = 'forward' AND created_at > ?`,
      account.id,
      since7,
    ),
    receipts7d: countWhere(
      `SELECT COUNT(*) AS n FROM warmup_messages WHERE from_account_id = ? AND kind = 'mdn' AND created_at > ?`,
      account.id,
      since7,
    ),
    throttlePercent: warm?.throttlePercent ?? 100,
    pauseReason: warm?.pauseReason ?? null,
    pausedUntil: warm?.pausedUntil ?? null,
    canWrite: providerFor(account.provider).supportsWrite(accountGrantedScopes(account.id)),
    pendingTasks: countWhere(
      `SELECT COUNT(*) AS n FROM warmup_tasks WHERE account_id = ? AND status = 'pending'`,
      account.id,
    ),
    lastEvent: lastEvent ?? null,
    timezone: tz,
  };
}

export interface PoolInfo {
  /** Opted-in, active mailboxes this org can pair with. */
  reachable: number;
  /** Opted-in across the whole instance. */
  instance: number;
  minSize: number;
}

export function poolInfo(org: Org): PoolInfo {
  const instance = countWhere(
    `SELECT COUNT(*) AS n FROM warmup_accounts w JOIN accounts a ON a.id = w.account_id
     WHERE w.enabled = 1 AND a.status = 'active' AND w.state IN ('ramping','steady','auto_paused')`,
  );
  const reachable =
    org.warmupPoolScope === 'org'
      ? countWhere(
          `SELECT COUNT(*) AS n FROM warmup_accounts w JOIN accounts a ON a.id = w.account_id
           WHERE w.enabled = 1 AND a.status = 'active' AND a.org_id = ? AND w.state IN ('ramping','steady','auto_paused')`,
          org.id,
        )
      : countWhere(
          `SELECT COUNT(*) AS n FROM warmup_accounts w JOIN accounts a ON a.id = w.account_id
           JOIN orgs o ON o.id = a.org_id
           WHERE w.enabled = 1 AND a.status = 'active' AND w.state IN ('ramping','steady','auto_paused')
             AND (o.warmup_pool_scope = 'instance' OR a.org_id = ?)`,
          org.id,
        );
  return { reachable, instance, minSize: config.WARMUP_MIN_POOL_SIZE };
}

export interface OrgWarmupOverview {
  accounts: AccountWarmupSummary[];
  pool: PoolInfo;
  content: { mix: ReturnType<typeof contentSourceMix>; llm: ReturnType<typeof llmStatus> };
  org: {
    poolScope: Org['warmupPoolScope'];
    filterTag: string | null;
    emitWebhooks: boolean;
    showInSendLog: boolean;
    defaults: ResolvedWarmupSettings;
    dailyCap: number;
  };
  totals: { enabled: number; sentToday: number; inbox7d: number; spam7d: number; missing7d: number };
}

export function orgWarmupOverview(org: Org): OrgWarmupOverview {
  const accounts = db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.orgId, org.id))
    .orderBy(desc(schema.accounts.createdAt))
    .all();
  const warmRows = accounts.length
    ? db
        .select()
        .from(schema.warmupAccounts)
        .where(inArray(schema.warmupAccounts.accountId, accounts.map((a) => a.id)))
        .all()
    : [];
  const warmById = new Map(warmRows.map((w) => [w.accountId, w]));
  const summaries = accounts.map((a) => summarizeAccount(a, org, warmById.get(a.id)));
  const defaults = resolveWarmupSettings(org, null);
  return {
    accounts: summaries,
    pool: poolInfo(org),
    content: { mix: contentSourceMix(7), llm: llmStatus() },
    org: {
      poolScope: org.warmupPoolScope,
      filterTag: org.warmupFilterTag,
      emitWebhooks: !!org.warmupEmitWebhooks,
      showInSendLog: !!org.warmupShowInSendLog,
      defaults,
      dailyCap: defaults.dailyCap,
    },
    totals: {
      enabled: summaries.filter((s) => s.enabled).length,
      sentToday: summaries.reduce((n, s) => n + s.todaySent, 0),
      inbox7d: summaries.reduce((n, s) => n + s.placement7d.inbox + s.placement7d.category, 0),
      spam7d: summaries.reduce((n, s) => n + s.placement7d.spam, 0),
      missing7d: summaries.reduce((n, s) => n + s.placement7d.missing, 0),
    },
  };
}

export interface WarmupMessageRow {
  id: string;
  direction: 'sent' | 'received';
  kind: string;
  subject: string;
  counterparty: string;
  createdAt: number;
  sentAt: number | null;
  landed: string | null;
  landedAt: number | null;
  rescuedAt: number | null;
  readAt: number | null;
  starredAt: number | null;
  repliedAt: number | null;
  forwardedAt: number | null;
  receiptSentAt: number | null;
  cleanedAt: number | null;
  contentSource: string;
  failError: string | null;
}

/** Sent and received warmup mail for one mailbox, newest first. */
export function recentWarmupMessages(accountId: string, limit = 40): WarmupMessageRow[] {
  const rows = sqlite
    .prepare(
      `SELECT m.id, m.kind, m.subject, m.created_at AS createdAt, m.sent_at AS sentAt,
              m.content_source AS contentSource, m.fail_error AS failError,
              l.to_account_id AS toAccountId, m.from_account_id AS fromAccountId,
              l.landed, l.landed_at AS landedAt, l.rescued_at AS rescuedAt, l.read_at AS readAt,
              l.starred_at AS starredAt, l.replied_at AS repliedAt, l.forwarded_at AS forwardedAt,
              l.receipt_sent_at AS receiptSentAt, l.cleaned_at AS cleanedAt,
              af.email AS fromEmail, at.email AS toEmail
       FROM warmup_landings l
       JOIN warmup_messages m ON m.id = l.message_id
       LEFT JOIN accounts af ON af.id = m.from_account_id
       LEFT JOIN accounts at ON at.id = l.to_account_id
       WHERE l.from_account_id = ? OR l.to_account_id = ?
       ORDER BY m.created_at DESC LIMIT ?`,
    )
    .all(accountId, accountId, limit) as Record<string, unknown>[];
  return rows.map((r) => {
    const sent = r.fromAccountId === accountId;
    return {
      id: r.id as string,
      direction: sent ? 'sent' : 'received',
      kind: r.kind as string,
      subject: r.subject as string,
      counterparty: (sent ? r.toEmail : r.fromEmail) as string,
      createdAt: r.createdAt as number,
      sentAt: r.sentAt as number | null,
      landed: r.landed as string | null,
      landedAt: r.landedAt as number | null,
      rescuedAt: r.rescuedAt as number | null,
      readAt: r.readAt as number | null,
      starredAt: r.starredAt as number | null,
      repliedAt: r.repliedAt as number | null,
      forwardedAt: r.forwardedAt as number | null,
      receiptSentAt: r.receiptSentAt as number | null,
      cleanedAt: r.cleanedAt as number | null,
      contentSource: r.contentSource as string,
      failError: r.failError as string | null,
    };
  });
}

export interface DailyPoint {
  date: string;
  sent: number;
  inbox: number;
  spam: number;
  category: number;
  missing: number;
  received: number;
  replies: number;
}

/** Per sender-local day, last `days` days. */
export function dailySeries(accountId: string, days = 30): DailyPoint[] {
  const sentRows = sqlite
    .prepare(
      `SELECT local_date AS date,
              COALESCE(SUM(kind != 'mdn' AND sent_at IS NOT NULL), 0) AS sent,
              COALESCE(SUM(kind = 'reply'), 0) AS replies
       FROM warmup_messages WHERE from_account_id = ? GROUP BY local_date ORDER BY local_date DESC LIMIT ?`,
    )
    .all(accountId, days) as { date: string; sent: number; replies: number }[];
  const landRows = sqlite
    .prepare(
      `SELECT local_date AS date,
              COALESCE(SUM(landed = 'inbox'), 0) AS inbox,
              COALESCE(SUM(landed = 'spam'), 0) AS spam,
              COALESCE(SUM(landed IN ('promotions','social','updates','forums','other')), 0) AS category,
              COALESCE(SUM(landed = 'missing'), 0) AS missing
       FROM warmup_landings WHERE from_account_id = ? GROUP BY local_date ORDER BY local_date DESC LIMIT ?`,
    )
    .all(accountId, days) as { date: string; inbox: number; spam: number; category: number; missing: number }[];
  const recvRows = sqlite
    .prepare(
      `SELECT local_date AS date, COUNT(*) AS received
       FROM warmup_landings WHERE to_account_id = ? GROUP BY local_date ORDER BY local_date DESC LIMIT ?`,
    )
    .all(accountId, days) as { date: string; received: number }[];
  const byDate = new Map<string, DailyPoint>();
  const point = (date: string) => {
    let p = byDate.get(date);
    if (!p) {
      p = { date, sent: 0, inbox: 0, spam: 0, category: 0, missing: 0, received: 0, replies: 0 };
      byDate.set(date, p);
    }
    return p;
  };
  for (const r of sentRows) Object.assign(point(r.date), { sent: r.sent, replies: r.replies });
  for (const r of landRows) Object.assign(point(r.date), { inbox: r.inbox, spam: r.spam, category: r.category, missing: r.missing });
  for (const r of recvRows) point(r.date).received = r.received;
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-days);
}

export interface ScheduleEntry {
  kind: string;
  dueAt: number;
  counterparty: string | null;
  status: string;
}

export function todaysSchedule(accountId: string, limit = 60): ScheduleEntry[] {
  const rows = sqlite
    .prepare(
      `SELECT t.kind, t.due_at AS dueAt, t.status, a.email AS counterparty
       FROM warmup_tasks t LEFT JOIN accounts a ON a.id = t.counterparty_account_id
       WHERE t.account_id = ? AND t.status IN ('pending','claimed')
       ORDER BY t.due_at ASC LIMIT ?`,
    )
    .all(accountId, limit) as ScheduleEntry[];
  return rows;
}

export interface AccountWarmupDetail {
  summary: AccountWarmupSummary;
  settings: ResolvedWarmupSettings;
  overrides: Record<string, unknown>;
  persona: Persona;
  messages: WarmupMessageRow[];
  schedule: ScheduleEntry[];
  daily: DailyPoint[];
}

export function accountWarmupDetail(account: Account, org: Org): AccountWarmupDetail {
  const warm = getWarmupAccount(account.id);
  let overrides: Record<string, unknown> = {};
  try {
    overrides = warm?.settingsJson ? (JSON.parse(warm.settingsJson) as Record<string, unknown>) : {};
  } catch {
    overrides = {};
  }
  return {
    summary: summarizeAccount(account, org, warm),
    settings: resolveWarmupSettings(org, warm),
    overrides,
    persona: personaFor(account, warm),
    messages: recentWarmupMessages(account.id, 40),
    schedule: todaysSchedule(account.id),
    daily: dailySeries(account.id, 30),
  };
}

/** Enabled mailboxes that sent nothing for two days while active: stalled. */
export function stalledAccounts(orgId: string): { email: string; lastSentAt: number | null }[] {
  const rows = sqlite
    .prepare(
      `SELECT a.email, (SELECT MAX(sent_at) FROM warmup_messages m WHERE m.from_account_id = a.id) AS lastSentAt
       FROM warmup_accounts w JOIN accounts a ON a.id = w.account_id
       WHERE a.org_id = ? AND w.enabled = 1 AND w.state IN ('ramping','steady') AND a.status = 'active'
         AND w.started_at < ?`,
    )
    .all(orgId, Date.now() - 2 * 24 * 3600_000) as { email: string; lastSentAt: number | null }[];
  return rows.filter((r) => (r.lastSentAt ?? 0) < Date.now() - 2 * 24 * 3600_000);
}

export function warmupTaskFailures24h(orgId: string): number {
  return countWhere(
    `SELECT COUNT(*) AS n FROM warmup_tasks t JOIN accounts a ON a.id = t.account_id
     WHERE a.org_id = ? AND t.status = 'failed' AND t.done_at > ?`,
    orgId,
    Date.now() - 24 * 3600_000,
  );
}

