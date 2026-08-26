/**
 * Outbound delivery events.
 *
 * The queue owns the send job's lifecycle; this module turns its terminal
 * transitions into webhook events. It lives outside sendQueue.ts on purpose:
 * the webhook dispatcher already imports the queue's backoff helper, and
 * emitting from inside the queue would close that import cycle.
 *
 * State is re-read from the row rather than passed in, so an event always
 * reflects what was actually committed — including the "exhausted all
 * attempts" path, where the queue itself decides the job is finally failed.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { dispatchEvent } from '../inbound/webhooks.js';
import type { Account } from '../db/schema.js';

export function emitSendOutcome(account: Account, jobId: string): void {
  const job = db
    .select()
    .from(schema.sendJobs)
    .where(eq(schema.sendJobs.id, jobId))
    .get();
  if (!job) return;
  // Only terminal states are events; queued/sending/retrying are internal.
  if (job.status !== 'sent' && job.status !== 'failed') return;
  let to: string[] = [];
  try {
    const envelope = JSON.parse(job.envelopeJson) as { to?: string[] };
    if (Array.isArray(envelope.to)) to = envelope.to;
  } catch {
    // An unparseable envelope must not cost us the event.
  }
  dispatchEvent(
    {
      event: job.status === 'sent' ? 'message.sent' : 'message.failed',
      account: { id: account.id, email: account.email, provider: account.provider },
      send: {
        jobId: job.id,
        messageId: job.messageId,
        providerMessageId: job.providerMessageId,
        subject: job.subject,
        to,
        error: job.status === 'failed' ? job.lastError : null,
      },
    },
    account.orgId,
  );
}
