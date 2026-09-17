import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { providerFor } from '../providers/index.js';
import { AuthError, RetryableError } from '../providers/errors.js';
import { logger } from '../logger.js';
import { logActivity } from '../observability/activity.js';
import type { SendJob } from '../db/schema.js';
import { emitSendOutcome } from './outcome-events.js';
import { onWarmupJobSent, onWarmupJobFailed } from '../warmup/ledger.js';
import {
  claimJobs,
  markSent,
  markRetry,
  markAuthBlocked,
  markFailed,
  reapStuckJobs,
  cleanupSentRaw,
  queueEvents,
} from './sendQueue.js';

const workerId = `worker-${nanoid(8)}`;
let running = false;
let stopped = false;

export async function processJob(job: SendJob): Promise<void> {
  const account = db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, job.accountId))
    .get();
  if (!account) {
    markFailed(job.id, 'Account no longer exists');
    return;
  }
  if (!job.rawPath) {
    markFailed(job.id, 'Raw message file no longer available');
    return;
  }
  let raw: Buffer;
  try {
    raw = fs.readFileSync(job.rawPath);
  } catch (err) {
    markFailed(job.id, `Raw message file missing: ${String(err)}`);
    return;
  }
  const envelope = JSON.parse(job.envelopeJson) as { to: string[] };
  const jobDetail = `job=${job.id} attempt=${job.attempts + 1} to=${envelope.to.join(',')} subject=${job.subject ?? ''}`.slice(0, 400);
  try {
    // A re-dispatched job (reaped after a crash, or retried after a network
    // error) may already have gone out on the earlier attempt. Ask the
    // provider whether a message with this Message-ID is already sent before
    // sending again; if so, adopt it instead of delivering a duplicate. Only
    // on re-dispatch (dispatchAttempts > 1), so first sends pay no extra call.
    if (job.dispatchAttempts > 1 && job.messageId) {
      const already = await providerFor(account.provider).findSentMessageId(job.accountId, job.messageId);
      if (already) {
        markSent(job.id, already);
        if (job.source === 'warmup') onWarmupJobSent(job);
        else emitSendOutcome(account, job.id);
        logger.warn({ jobId: job.id, account: account.email, providerMessageId: already }, 'job already delivered on a prior attempt; adopted, not resent');
        logActivity({ category: 'delivery', action: 'deduped-resend', status: 'ok', accountId: account.id, detail: jobDetail });
        return;
      }
    }
    const providerMessageId = await providerFor(account.provider).sendRaw(job.accountId, raw);
    markSent(job.id, providerMessageId);
    if (job.source === 'warmup') onWarmupJobSent(job);
    else emitSendOutcome(account, job.id);
    logger.info(
      { jobId: job.id, account: account.email, subject: job.subject },
      'message sent',
    );
    logActivity({
      category: 'delivery',
      action: 'sent',
      status: 'ok',
      accountId: account.id,
      detail: jobDetail,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AuthError) {
      markAuthBlocked(job, message);
      logger.warn({ jobId: job.id, account: account.email }, 'send blocked on auth; account paused');
      logActivity({
        category: 'delivery',
        action: 'auth-blocked',
        status: 'failed',
        accountId: account.id,
        detail: jobDetail,
        error: `Account paused pending reconnect: ${message}`,
      });
    } else if (err instanceof RetryableError) {
      markRetry(job, message);
      // markRetry flips the job to `failed` once attempts run out; the emit
      // is a no-op while it is still retrying.
      if (job.source === 'warmup') {
        if (job.attempts + 1 >= job.maxAttempts) onWarmupJobFailed(job, message);
      } else emitSendOutcome(account, job.id);
      logger.warn({ jobId: job.id, attempts: job.attempts + 1, err: message }, 'send failed; will retry');
      logActivity({
        category: 'delivery',
        action: 'retry',
        status: 'failed',
        accountId: account.id,
        detail: jobDetail,
        error: message,
      });
    } else {
      markFailed(job.id, message);
      if (job.source === 'warmup') onWarmupJobFailed(job, message);
      else emitSendOutcome(account, job.id);
      logger.error({ jobId: job.id, err: message }, 'send failed permanently');
      logActivity({
        category: 'delivery',
        action: 'permanent-failure',
        status: 'failed',
        accountId: account.id,
        detail: jobDetail,
        error: message,
      });
    }
  }
}

async function tick(): Promise<void> {
  if (running || stopped) return;
  running = true;
  try {
    for (;;) {
      const jobs = claimJobs(workerId);
      if (jobs.length === 0) break;
      await Promise.allSettled(jobs.map(processJob));
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'send worker tick failed');
  } finally {
    running = false;
  }
}

export function startSendWorker(): () => void {
  stopped = false;
  running = false;
  reapStuckJobs(0); // anything 'sending' at boot is from a previous crash
  const interval = setInterval(tick, 1000);
  interval.unref();
  const reaper = setInterval(() => reapStuckJobs(), 60_000);
  reaper.unref();
  cleanupSentRaw();
  const spoolCleaner = setInterval(() => {
    const cleaned = cleanupSentRaw();
    if (cleaned > 0) logger.info({ cleaned }, 'removed sent spool files past retention');
  }, 10 * 60_000);
  spoolCleaner.unref();
  queueEvents.on('enqueued', tick);
  logger.info({ workerId }, 'send worker started');
  return () => {
    stopped = true;
    clearInterval(interval);
    clearInterval(reaper);
    clearInterval(spoolCleaner);
    queueEvents.off('enqueued', tick);
  };
}
