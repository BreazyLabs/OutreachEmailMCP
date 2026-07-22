import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { loadAccount, requireScope } from './plugin.js';
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
});

export function registerSendLogRoutes(app: FastifyInstance) {
  app.get<{ Params: { accountId: string }; Querystring: Record<string, string> }>(
    '/accounts/:accountId/send-jobs',
    async (req, reply) => {
      if (!requireScope(req, reply, 'read')) return;
      const account = loadAccount(req.params.accountId, req);
      if (!account) return reply.code(404).send({ error: 'Unknown account' });
      const query = listQuery.parse(req.query);
      const where = query.status
        ? and(eq(schema.sendJobs.accountId, account.id), eq(schema.sendJobs.status, query.status))
        : eq(schema.sendJobs.accountId, account.id);
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
