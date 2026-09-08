/**
 * Durable task queue for the warmup engine. Same shape as the send queue:
 * atomic claim with a lease, a reaper for expired leases, exponential
 * backoff on failure, and an idempotency key so re-planning after a crash
 * cannot enqueue the same work twice.
 */

import { nanoid } from 'nanoid';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db, sqlite, schema } from '../db/index.js';
import { backoffMs } from '../queue/sendQueue.js';
import { config } from '../config.js';
import type { WarmupTask } from '../db/schema.js';

export type TaskKind = WarmupTask['kind'];

// Send-type tasks are pointless late: a burst of "morning" mail at 15:00 is
// exactly the pattern warmup exists to avoid. Engagement tasks are fine late.
const SKIPPABLE: Set<TaskKind> = new Set(['send_open', 'send_reply', 'send_forward', 'send_mdn']);

export interface EnqueueTask {
  accountId: string;
  counterpartyAccountId?: string | null;
  kind: TaskKind;
  dueAt: number;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
}

/** Insert unless the key exists. Returns the new row, or null if a task with
 *  that key was already there. */
export function enqueueTask(input: EnqueueTask): WarmupTask | null {
  const now = Date.now();
  const id = nanoid();
  const result = sqlite
    .prepare(
      `INSERT OR IGNORE INTO warmup_tasks
       (id, account_id, counterparty_account_id, kind, due_at, idempotency_key, payload_json,
        status, attempts, max_attempts, created_at)
       VALUES (@id, @accountId, @counterparty, @kind, @dueAt, @key, @payload, 'pending', 0,
               @maxAttempts, @now)`,
    )
    .run({
      id,
      accountId: input.accountId,
      counterparty: input.counterpartyAccountId ?? null,
      kind: input.kind,
      dueAt: Math.floor(input.dueAt),
      key: input.idempotencyKey,
      payload: JSON.stringify(input.payload),
      maxAttempts: input.maxAttempts ?? 5,
      now,
    });
  if (result.changes === 0) return null;
  return db.select().from(schema.warmupTasks).where(eq(schema.warmupTasks.id, id)).get() ?? null;
}

const claimStmt = () =>
  sqlite.prepare(`
    UPDATE warmup_tasks SET status = 'claimed', locked_at = @now, locked_by = @worker
    WHERE id IN (
      SELECT id FROM (
        SELECT t.id AS id, MIN(t.due_at)
        FROM warmup_tasks t
        JOIN accounts a ON a.id = t.account_id
        JOIN warmup_accounts w ON w.account_id = t.account_id
        WHERE t.status = 'pending' AND t.due_at <= @now
          AND a.status = 'active' AND w.enabled = 1
          AND w.state NOT IN ('off', 'blocked_upstream', 'paused')
          -- new conversations only while actively warming; replies and
          -- receipts keep going through an auto-pause so threads stay coherent
          AND (t.kind NOT IN ('send_open', 'send_forward') OR w.state IN ('ramping', 'steady'))
          AND t.account_id NOT IN (SELECT account_id FROM warmup_tasks WHERE status = 'claimed')
        GROUP BY t.account_id
      )
      LIMIT @limit
    )
    RETURNING *
  `);

export function claimTasks(workerId: string, limit = 10): WarmupTask[] {
  const rows = claimStmt().all({ now: Date.now(), worker: workerId, limit }) as Record<
    string,
    unknown
  >[];
  return rows.map(rowToTask);
}

function rowToTask(r: Record<string, unknown>): WarmupTask {
  return {
    id: r.id,
    accountId: r.account_id,
    counterpartyAccountId: r.counterparty_account_id,
    kind: r.kind,
    dueAt: r.due_at,
    idempotencyKey: r.idempotency_key,
    payloadJson: r.payload_json,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    lockedAt: r.locked_at,
    lockedBy: r.locked_by,
    lastError: r.last_error,
    createdAt: r.created_at,
    doneAt: r.done_at,
  } as WarmupTask;
}

export function completeTask(taskId: string): void {
  db.update(schema.warmupTasks)
    .set({ status: 'done', doneAt: Date.now(), lockedAt: null, lockedBy: null, lastError: null })
    .where(eq(schema.warmupTasks.id, taskId))
    .run();
}

export function skipTask(taskId: string, reason: string): void {
  db.update(schema.warmupTasks)
    .set({
      status: 'skipped',
      doneAt: Date.now(),
      lockedAt: null,
      lockedBy: null,
      lastError: reason.slice(0, 500),
    })
    .where(eq(schema.warmupTasks.id, taskId))
    .run();
}

/** Retry with backoff, or fail once attempts run out. Returns the new status. */
export function failTask(task: WarmupTask, error: string): 'pending' | 'failed' {
  const attempts = task.attempts + 1;
  if (attempts >= task.maxAttempts) {
    db.update(schema.warmupTasks)
      .set({
        status: 'failed',
        attempts,
        doneAt: Date.now(),
        lockedAt: null,
        lockedBy: null,
        lastError: error.slice(0, 1000),
      })
      .where(eq(schema.warmupTasks.id, task.id))
      .run();
    return 'failed';
  }
  db.update(schema.warmupTasks)
    .set({
      status: 'pending',
      attempts,
      dueAt: Date.now() + backoffMs(attempts),
      lockedAt: null,
      lockedBy: null,
      lastError: error.slice(0, 1000),
    })
    .where(eq(schema.warmupTasks.id, task.id))
    .run();
  return 'pending';
}

/** Return tasks whose lease expired (crash mid-task) to the queue. */
export function reapStuckTasks(olderThanMs = 5 * 60_000): number {
  const result = sqlite
    .prepare(
      `UPDATE warmup_tasks SET status = 'pending', locked_at = NULL, locked_by = NULL
       WHERE status = 'claimed' AND locked_at < @cutoff`,
    )
    .run({ cutoff: Date.now() - olderThanMs });
  return result.changes;
}

/** Send tasks that are past the grace window are skipped, never run late. */
export function skipStaleSendTasks(graceMinutes = config.WARMUP_TASK_GRACE_MINUTES): number {
  const cutoff = Date.now() - graceMinutes * 60_000;
  const result = sqlite
    .prepare(
      `UPDATE warmup_tasks SET status = 'skipped', done_at = @now,
         last_error = 'Missed its window (engine was not running)'
       WHERE status = 'pending' AND due_at < @cutoff
         AND kind IN (${[...SKIPPABLE].map((k) => `'${k}'`).join(',')})`,
    )
    .run({ now: Date.now(), cutoff });
  return result.changes;
}

/** Drop every pending task an account owns (disable / pause / auth loss). */
export function cancelPendingTasks(accountId: string, reason: string, kinds?: TaskKind[]): number {
  const kindClause = kinds?.length ? `AND kind IN (${kinds.map((k) => `'${k}'`).join(',')})` : '';
  const result = sqlite
    .prepare(
      `UPDATE warmup_tasks SET status = 'skipped', done_at = @now, last_error = @reason
       WHERE account_id = @accountId AND status = 'pending' ${kindClause}`,
    )
    .run({ now: Date.now(), accountId, reason: reason.slice(0, 500) });
  return result.changes;
}

export function pendingTasksFor(accountId: string, limit = 50): WarmupTask[] {
  return db
    .select()
    .from(schema.warmupTasks)
    .where(and(eq(schema.warmupTasks.accountId, accountId), eq(schema.warmupTasks.status, 'pending')))
    .orderBy(schema.warmupTasks.dueAt)
    .limit(limit)
    .all();
}

/** Pending sends whose counterparty is `accountId` and that are due inside
 *  [from, to): the mail a mailbox is already going to receive. */
export function plannedInboundCount(accountId: string, from: number, to: number): number {
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM warmup_tasks
       WHERE counterparty_account_id = ? AND status IN ('pending','claimed')
         AND kind IN ('send_open','send_reply','send_forward') AND due_at >= ? AND due_at < ?`,
    )
    .get(accountId, from, to) as { n: number };
  return row.n;
}

export function pendingSendCount(accountId: string, from: number, to: number): number {
  return db
    .select({ n: sql<number>`count(*)` })
    .from(schema.warmupTasks)
    .where(
      and(
        eq(schema.warmupTasks.accountId, accountId),
        eq(schema.warmupTasks.status, 'pending'),
        sql`${schema.warmupTasks.kind} IN ('send_open','send_reply','send_forward')`,
        gte(schema.warmupTasks.dueAt, from),
        lt(schema.warmupTasks.dueAt, to),
      ),
    )
    .get()!.n;
}

/** An account is being deleted: its queued work must not outlive it.
 *  Ledger rows stay — they are the other side's placement history. */
export function purgeAccountTasks(accountId: string): number {
  return sqlite
    .prepare(`DELETE FROM warmup_tasks WHERE account_id = ? OR counterparty_account_id = ?`)
    .run(accountId, accountId).changes;
}

/** Housekeeping: finished tasks older than the retention window. */
export function pruneTasks(retentionDays = 14): number {
  const result = sqlite
    .prepare(
      `DELETE FROM warmup_tasks WHERE status IN ('done','skipped','failed') AND done_at < ?`,
    )
    .run(Date.now() - retentionDays * 24 * 3600_000);
  return result.changes;
}
