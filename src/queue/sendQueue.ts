import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { db, sqlite, schema } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { extractHeader, ensureEnvelopeRecipients } from '../utils/mime-headers.js';
import { assertCanSend } from '../tenancy/orgs.js';
import type { SendJob } from '../db/schema.js';

export interface Envelope {
  from: string;
  to: string[];
}

// Lets the worker wake immediately when something is enqueued instead of
// waiting for the next poll tick.
export const queueEvents = new EventEmitter();

// Throws QuotaError when the owning org is suspended or over its send limit.
export function enqueueSend(input: {
  accountId: string;
  source: 'api' | 'smtp';
  raw: Buffer;
  envelope: Envelope;
  subject: string | null;
}): SendJob {
  const account = db
    .select({ orgId: schema.accounts.orgId })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, input.accountId))
    .get();
  if (account) assertCanSend(account.orgId);
  const id = nanoid();
  const rawPath = path.join(config.messagesDir, `${id}.eml`);
  const raw = ensureEnvelopeRecipients(input.raw, input.envelope.to);
  fs.writeFileSync(rawPath, raw);
  const now = Date.now();
  const job = db
    .insert(schema.sendJobs)
    .values({
      id,
      accountId: input.accountId,
      source: input.source,
      status: 'queued',
      rawPath,
      envelopeJson: JSON.stringify(input.envelope),
      subject: input.subject,
      messageId: extractHeader(input.raw, 'Message-ID'),
      nextAttemptAt: now,
      createdAt: now,
    })
    .returning()
    .get();
  queueEvents.emit('enqueued');
  return job;
}

const claimStmt = () =>
  sqlite.prepare(`
    UPDATE send_jobs SET status = 'sending', locked_at = @now, locked_by = @worker
    WHERE id IN (
      SELECT id FROM (
        SELECT j.id AS id, MIN(j.next_attempt_at)
        FROM send_jobs j
        JOIN accounts a ON a.id = j.account_id
        WHERE j.status = 'queued' AND j.next_attempt_at <= @now AND a.status = 'active'
          AND j.account_id NOT IN (SELECT account_id FROM send_jobs WHERE status = 'sending')
        GROUP BY j.account_id
      )
      LIMIT @limit
    )
    RETURNING *
  `);

// Claim up to `limit` due jobs, at most one per account (keeps per-account
// ordering and avoids provider rate-limit bursts). Atomic UPDATE...RETURNING.
export function claimJobs(workerId: string, limit = 5): SendJob[] {
  const rows = claimStmt().all({ now: Date.now(), worker: workerId, limit }) as Record<
    string,
    unknown
  >[];
  return rows.map(rowToJob);
}

function rowToJob(r: Record<string, unknown>): SendJob {
  return {
    id: r.id,
    accountId: r.account_id,
    source: r.source,
    status: r.status,
    rawPath: r.raw_path,
    envelopeJson: r.envelope_json,
    subject: r.subject,
    messageId: r.message_id,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    nextAttemptAt: r.next_attempt_at,
    lockedAt: r.locked_at,
    lockedBy: r.locked_by,
    providerMessageId: r.provider_message_id,
    lastError: r.last_error,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  } as SendJob;
}

export function markSent(jobId: string, providerMessageId: string | null): void {
  db.update(schema.sendJobs)
    .set({
      status: 'sent',
      providerMessageId,
      sentAt: Date.now(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    })
    .where(eq(schema.sendJobs.id, jobId))
    .run();
}

export function backoffMs(attempts: number): number {
  const base = Math.min(2 ** attempts, 3600) * 1000;
  return base + Math.floor(Math.random() * 30_000);
}

export function markRetry(job: SendJob, error: string): void {
  const attempts = job.attempts + 1;
  if (attempts >= job.maxAttempts) {
    markFailed(job.id, `Exhausted ${attempts} attempts. Last error: ${error}`);
    return;
  }
  db.update(schema.sendJobs)
    .set({
      status: 'queued',
      attempts,
      nextAttemptAt: Date.now() + backoffMs(attempts),
      lockedAt: null,
      lockedBy: null,
      lastError: error.slice(0, 1000),
    })
    .where(eq(schema.sendJobs.id, job.id))
    .run();
}

// Auth failures: requeue without burning an attempt — the account is paused
// (status != active) so the claim query skips it until the user reconnects.
export function markAuthBlocked(job: SendJob, error: string): void {
  db.update(schema.sendJobs)
    .set({
      status: 'queued',
      nextAttemptAt: Date.now() + 60_000,
      lockedAt: null,
      lockedBy: null,
      lastError: error.slice(0, 1000),
    })
    .where(eq(schema.sendJobs.id, job.id))
    .run();
}

export function markFailed(jobId: string, error: string): void {
  db.update(schema.sendJobs)
    .set({
      status: 'failed',
      lockedAt: null,
      lockedBy: null,
      lastError: error.slice(0, 1000),
    })
    .where(eq(schema.sendJobs.id, jobId))
    .run();
}

// Delete spool files of successfully sent jobs after the retention window.
// Failed/queued jobs keep their raw file — it's the only copy the provider
// never received. Sent mail remains fetchable from the provider itself
// (Gmail via provider_message_id, Graph via the stored Message-ID header).
export function cleanupSentRaw(retentionMs = config.SENT_RAW_RETENTION_HOURS * 3600_000): number {
  const rows = sqlite
    .prepare(
      `SELECT id, raw_path FROM send_jobs
       WHERE status = 'sent' AND raw_path IS NOT NULL AND sent_at < @cutoff
       LIMIT 500`,
    )
    .all({ cutoff: Date.now() - retentionMs }) as { id: string; raw_path: string }[];
  let cleaned = 0;
  for (const row of rows) {
    try {
      fs.rmSync(row.raw_path, { force: true });
      db.update(schema.sendJobs)
        .set({ rawPath: null })
        .where(eq(schema.sendJobs.id, row.id))
        .run();
      cleaned++;
    } catch (err) {
      logger.warn({ jobId: row.id, err: String(err) }, 'failed to clean up spool file');
    }
  }
  return cleaned;
}

// Remove on-disk files belonging to an account (called before the row cascade
// deletes its send_jobs / imap_messages, which would orphan the files).
export function deleteAccountSpoolFiles(accountId: string): void {
  const rows = [
    ...(sqlite
      .prepare(`SELECT raw_path AS p FROM send_jobs WHERE account_id = ? AND raw_path IS NOT NULL`)
      .all(accountId) as { p: string }[]),
    ...(sqlite
      .prepare(`SELECT local_path AS p FROM imap_messages WHERE account_id = ? AND local_path IS NOT NULL`)
      .all(accountId) as { p: string }[]),
  ];
  for (const row of rows) {
    try {
      fs.rmSync(row.p, { force: true });
    } catch (err) {
      logger.warn({ path: row.p, err: String(err) }, 'failed to delete spool file');
    }
  }
}

// Return jobs stuck in 'sending' (crash mid-send) to the queue.
export function reapStuckJobs(olderThanMs = 5 * 60_000): number {
  const result = sqlite
    .prepare(
      `UPDATE send_jobs SET status = 'queued', locked_at = NULL, locked_by = NULL,
       next_attempt_at = @now
       WHERE status = 'sending' AND locked_at < @cutoff`,
    )
    .run({ now: Date.now(), cutoff: Date.now() - olderThanMs });
  return result.changes;
}
