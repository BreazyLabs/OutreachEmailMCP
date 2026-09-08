/**
 * The ledger: registry rows for every message the engine sends, one landing
 * row per recipient, and the hooks the send worker calls when a warmup job
 * is accepted or refused by the provider.
 */

import { nanoid } from 'nanoid';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db, sqlite, schema } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { logActivity } from '../observability/activity.js';
import type { SendJob, WarmupLanding, WarmupMessage } from '../db/schema.js';

export interface RegisterMessage {
  threadId: string;
  turn: number;
  kind: WarmupMessage['kind'];
  fromAccountId: string;
  toAccountId: string;
  ccAccountIds?: string[];
  rfcMessageId: string; // normalised
  inReplyToMessageId?: string | null;
  subject: string;
  contentSource: WarmupMessage['contentSource'];
  requestedReceipt?: boolean;
  localDate: string;
}

/** Write the registry row and a pending landing per recipient. */
export function registerMessage(input: RegisterMessage): WarmupMessage {
  const now = Date.now();
  const id = nanoid();
  const recipients = [input.toAccountId, ...(input.ccAccountIds ?? [])];
  const tx = sqlite.transaction(() => {
    db.insert(schema.warmupMessages)
      .values({
        id,
        threadId: input.threadId,
        turn: input.turn,
        kind: input.kind,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        ccAccountIdsJson: input.ccAccountIds?.length ? JSON.stringify(input.ccAccountIds) : null,
        rfcMessageId: input.rfcMessageId,
        inReplyToMessageId: input.inReplyToMessageId ?? null,
        subject: input.subject,
        contentSource: input.contentSource,
        requestedReceipt: input.requestedReceipt ? 1 : 0,
        localDate: input.localDate,
        createdAt: now,
      })
      .run();
    for (const to of recipients) {
      db.insert(schema.warmupLandings)
        .values({
          id: nanoid(),
          messageId: id,
          fromAccountId: input.fromAccountId,
          toAccountId: to,
          localDate: input.localDate,
          createdAt: now,
        })
        .run();
    }
  });
  tx();
  return db.select().from(schema.warmupMessages).where(eq(schema.warmupMessages.id, id)).get()!;
}

export function attachSendJob(messageId: string, sendJobId: string): void {
  db.update(schema.warmupMessages)
    .set({ sendJobId })
    .where(eq(schema.warmupMessages.id, messageId))
    .run();
}

export function messageById(id: string): WarmupMessage | undefined {
  return db.select().from(schema.warmupMessages).where(eq(schema.warmupMessages.id, id)).get();
}

export function landingFor(messageId: string, toAccountId: string): WarmupLanding | undefined {
  return db
    .select()
    .from(schema.warmupLandings)
    .where(
      and(eq(schema.warmupLandings.messageId, messageId), eq(schema.warmupLandings.toAccountId, toAccountId)),
    )
    .get();
}

export function landingById(id: string): WarmupLanding | undefined {
  return db.select().from(schema.warmupLandings).where(eq(schema.warmupLandings.id, id)).get();
}

export function updateLanding(id: string, patch: Partial<WarmupLanding>): void {
  db.update(schema.warmupLandings).set(patch).where(eq(schema.warmupLandings.id, id)).run();
}

// --- send worker hooks -------------------------------------------------------

/** The provider accepted the job: the message is on its way. */
export function onWarmupJobSent(job: SendJob): void {
  if (!job.warmupMessageId) return;
  const now = Date.now();
  db.update(schema.warmupMessages)
    .set({ sentAt: now, expectedBy: now + config.WARMUP_ARRIVAL_TIMEOUT_HOURS * 3600_000 })
    .where(eq(schema.warmupMessages.id, job.warmupMessageId))
    .run();
}

/** The provider refused the job for good: nothing will arrive anywhere. */
export function onWarmupJobFailed(job: SendJob, error: string): void {
  if (!job.warmupMessageId) return;
  const message = messageById(job.warmupMessageId);
  if (!message) return;
  db.update(schema.warmupMessages)
    .set({ failedAt: Date.now(), failError: error.slice(0, 500) })
    .where(eq(schema.warmupMessages.id, message.id))
    .run();
  db.delete(schema.warmupLandings).where(eq(schema.warmupLandings.messageId, message.id)).run();
  if (message.kind === 'open') {
    db.update(schema.warmupThreads)
      .set({ state: 'abandoned', updatedAt: Date.now() })
      .where(eq(schema.warmupThreads.id, message.threadId))
      .run();
  }
  logActivity({
    category: 'warmup',
    action: 'send-failed',
    status: 'failed',
    accountId: message.fromAccountId,
    detail: `${message.kind} "${message.subject}"`,
    error,
  });
}

/** A DSN came back for a warmup send. */
export function onWarmupBounce(job: SendJob, recipient: string | null, diagnostic: string | null): void {
  if (!job.warmupMessageId) return;
  const message = messageById(job.warmupMessageId);
  if (!message) return;
  const now = Date.now();
  // Attribute to the named recipient when the DSN says who, else to all.
  const landings = db
    .select({ landing: schema.warmupLandings, email: schema.accounts.email })
    .from(schema.warmupLandings)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.warmupLandings.toAccountId))
    .where(eq(schema.warmupLandings.messageId, message.id))
    .all();
  for (const { landing, email } of landings) {
    if (recipient && email.toLowerCase() !== recipient.toLowerCase()) continue;
    if (landing.landed) continue;
    updateLanding(landing.id, { landed: 'bounced', landedAt: now });
  }
  db.update(schema.warmupThreads)
    .set({ state: 'abandoned', updatedAt: now })
    .where(eq(schema.warmupThreads.id, message.threadId))
    .run();
  logActivity({
    category: 'warmup',
    action: 'bounced',
    status: 'failed',
    accountId: message.fromAccountId,
    detail: `"${message.subject}" to ${recipient ?? 'partner'}`,
    error: diagnostic ?? undefined,
  });
  logger.warn({ from: message.fromAccountId, subject: message.subject }, 'warmup message bounced');
}

/** Sent, past its arrival deadline, seen nowhere: missing. Returns count. */
export function markMissing(now = Date.now()): number {
  const rows = db
    .select({ landing: schema.warmupLandings, message: schema.warmupMessages })
    .from(schema.warmupLandings)
    .innerJoin(schema.warmupMessages, eq(schema.warmupMessages.id, schema.warmupLandings.messageId))
    .where(
      and(
        isNull(schema.warmupLandings.landed),
        sql`${schema.warmupMessages.sentAt} IS NOT NULL`,
        lt(schema.warmupMessages.expectedBy, now),
      ),
    )
    .limit(500)
    .all();
  for (const { landing, message } of rows) {
    updateLanding(landing.id, { landed: 'missing', landedAt: now });
    logActivity({
      category: 'warmup',
      action: 'missing',
      status: 'failed',
      accountId: message.fromAccountId,
      detail: `"${message.subject}" never showed up in the partner mailbox`,
    });
  }
  return rows.length;
}
