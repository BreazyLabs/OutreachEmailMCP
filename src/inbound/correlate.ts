/**
 * Correlate inbound mail back to the send job it answers.
 *
 * A send job's RFC822 Message-ID is written at submission time and is the
 * only identifier that survives the round trip through the recipient's mail
 * system, so it is the join key for both bounces (DSN naming the original)
 * and replies (`In-Reply-To`/`References`).
 *
 * Recording an outcome is idempotent: a mail system that sends the same DSN
 * twice, or a poller that re-reads a message after a cursor glitch, must not
 * produce two bounce events for one send.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { dispatchEvent } from './webhooks.js';
import { logActivity } from '../observability/activity.js';
import { logger } from '../logger.js';
import { normalizeMessageId, type BounceInfo } from './classify.js';
import type { Account, SendJob } from '../db/schema.js';

/** Find the send job whose Message-ID matches, scoped to the account that
 *  sent it (a bounce always arrives back at the sending mailbox). */
export function findSendJobByMessageId(
  accountId: string,
  messageId: string | null,
): SendJob | undefined {
  const normalized = normalizeMessageId(messageId);
  if (!normalized) return undefined;
  // Message-ID is stored as written (`<id@host>`); compare normalized.
  const candidates = db
    .select()
    .from(schema.sendJobs)
    .where(eq(schema.sendJobs.accountId, accountId))
    .all();
  return candidates.find((j) => normalizeMessageId(j.messageId) === normalized);
}

function recipientsOf(job: SendJob): string[] {
  try {
    const envelope = JSON.parse(job.envelopeJson) as { to?: string[] };
    return Array.isArray(envelope.to) ? envelope.to : [];
  } catch {
    return [];
  }
}

/** Record a bounce against its send job and fan out `message.bounced`.
 *  Returns true when this was a new bounce (not a duplicate DSN). */
export function recordBounce(account: Account, job: SendJob, bounce: BounceInfo): boolean {
  const now = Date.now();
  const updated = db
    .update(schema.sendJobs)
    .set({
      bouncedAt: now,
      bounceType: bounce.type,
      bounceCode: bounce.code,
      bounceRecipient: bounce.recipient,
      bounceDiagnostic: bounce.diagnostic,
    })
    // Only the first DSN wins — later copies find bounced_at already set.
    .where(and(eq(schema.sendJobs.id, job.id), isNull(schema.sendJobs.bouncedAt)))
    .run();
  if (updated.changes === 0) return false;

  dispatchEvent(
    {
      event: 'message.bounced',
      account: { id: account.id, email: account.email, provider: account.provider },
      send: {
        jobId: job.id,
        messageId: job.messageId,
        providerMessageId: job.providerMessageId,
        subject: job.subject,
        to: recipientsOf(job),
        bounce: {
          type: bounce.type,
          code: bounce.code,
          recipient: bounce.recipient,
          diagnostic: bounce.diagnostic,
        },
      },
    },
    account.orgId,
  );
  logActivity({
    category: 'delivery',
    action: 'bounce',
    status: 'failed',
    accountId: account.id,
    detail: `${bounce.type} bounce ${bounce.code ?? ''} for ${bounce.recipient ?? 'unknown recipient'}`.trim(),
    error: bounce.diagnostic ?? undefined,
  });
  logger.info(
    { account: account.email, jobId: job.id, type: bounce.type, code: bounce.code },
    'send bounced',
  );
  return true;
}

/** Record a reply against its send job and fan out `message.replied`.
 *  Only the FIRST reply is recorded — that is the one that matters for
 *  reply-rate reporting, and later messages in the thread would otherwise
 *  each look like a fresh reply. */
export function recordReply(
  account: Account,
  job: SendJob,
  reply: { messageId: string; from: string | null; snippet: string | null },
): boolean {
  const updated = db
    .update(schema.sendJobs)
    .set({ repliedAt: Date.now(), replyMessageId: reply.messageId })
    .where(and(eq(schema.sendJobs.id, job.id), isNull(schema.sendJobs.repliedAt)))
    .run();
  if (updated.changes === 0) return false;

  dispatchEvent(
    {
      event: 'message.replied',
      account: { id: account.id, email: account.email, provider: account.provider },
      send: {
        jobId: job.id,
        messageId: job.messageId,
        providerMessageId: job.providerMessageId,
        subject: job.subject,
        to: recipientsOf(job),
        reply,
      },
    },
    account.orgId,
  );
  logger.info({ account: account.email, jobId: job.id }, 'send replied to');
  return true;
}
