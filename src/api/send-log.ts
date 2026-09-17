import type { FastifyInstance } from 'fastify';
import { and, desc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { loadAccount, requireScope } from './plugin.js';
import { findRecentJobByMessageId } from '../queue/sendQueue.js';
import type { SendJob } from '../db/schema.js';

export function publicJob(j: SendJob) {
  return {
    id: j.id,
    accountId: j.accountId,
    source: j.source,
    status: j.status,
    envelope: JSON.parse(j.envelopeJson) as { from: string; to: string[] },
    subject: j.subject,
    attempts: j.attempts,
    nextAttemptAt: j.status === 'queued' ? j.nextAttemptAt : null,
    providerMessageId: j.providerMessageId,
    messageId: j.messageId,
    lastError: j.lastError,
    createdAt: j.createdAt,
    sentAt: j.sentAt,
  };
}

const listQuery = z.object({
  status: z.enum(['queued', 'sending', 'sent', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  // Warmup-engine sends are hidden by default: the send log is the
  // customer's own traffic.
  includeWarmup: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

export function registerSendLogRoutes(app: FastifyInstance) {
  app.get<{ Params: { accountId: string }; Querystring: Record<string, string> }>(
    '/accounts/:accountId/send-jobs',
    async (req, reply) => {
      if (!requireScope(req, reply, 'read')) return;
      const account = loadAccount(req.params.accountId, req);
      if (!account) return reply.code(404).send({ error: 'Unknown account' });
      // Look one job up by the caller's Message-ID (same normalisation and
      // 7-day window as submit-time dedup), so a caller whose submit timed out
      // can tell whether the send was ever enqueued. 404 = it was not.
      const wanted = typeof req.query.messageId === 'string' ? req.query.messageId : null;
      if (wanted) {
        const job = findRecentJobByMessageId(account.id, wanted);
        if (!job) return reply.code(404).send({ error: 'No send job with that Message-ID in the last 7 days' });
        return publicJob(job);
      }
      const query = listQuery.parse(req.query);
      const conditions = [eq(schema.sendJobs.accountId, account.id)];
      if (query.status) conditions.push(eq(schema.sendJobs.status, query.status));
      if (!query.includeWarmup) conditions.push(ne(schema.sendJobs.source, 'warmup'));
      const where = and(...conditions);
      const rows = db
        .select()
        .from(schema.sendJobs)
        .where(where)
        .orderBy(desc(schema.sendJobs.createdAt))
        .limit(query.limit)
        .offset(query.offset)
        .all();
      return rows.map(publicJob);
    },
  );

  app.get<{ Params: { accountId: string; jobId: string } }>(
    '/accounts/:accountId/send-jobs/:jobId',
    async (req, reply) => {
      if (!requireScope(req, reply, 'read')) return;
      const job = db
        .select()
        .from(schema.sendJobs)
        .where(
          and(
            eq(schema.sendJobs.id, req.params.jobId),
            eq(schema.sendJobs.accountId, req.params.accountId),
          ),
        )
        .get();
      if (!job) return reply.code(404).send({ error: 'Unknown job' });
      return publicJob(job);
    },
  );
}
