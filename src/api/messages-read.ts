import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { simpleParser } from 'mailparser';
import { providerFor } from '../providers/index.js';
import { loadAccount, requireScope } from './plugin.js';

const listQuery = z.object({
  folder: z.string().optional(),
  pageToken: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export function registerReadRoutes(app: FastifyInstance) {
  app.get<{ Params: { accountId: string } }>(
    '/accounts/:accountId/folders',
    async (req, reply) => {
      if (!requireScope(req, reply, 'read')) return;
      const account = loadAccount(req.params.accountId, req);
      if (!account) return reply.code(404).send({ error: 'Unknown account' });
      return providerFor(account.provider).listFolders(account.id);
    },
  );

  app.get<{ Params: { accountId: string }; Querystring: Record<string, string> }>(
    '/accounts/:accountId/messages',
    async (req, reply) => {
      if (!requireScope(req, reply, 'read')) return;
      const account = loadAccount(req.params.accountId, req);
      if (!account) return reply.code(404).send({ error: 'Unknown account' });
      const query = listQuery.parse(req.query);
      return providerFor(account.provider).listMessages(account.id, {
        folder: query.folder,
        pageToken: query.pageToken,
        query: query.q,
        limit: query.limit,
      });
    },
  );

  app.get<{
    Params: { accountId: string; messageId: string };
    Querystring: { format?: string };
  }>('/accounts/:accountId/messages/:messageId', async (req, reply) => {
      if (!requireScope(req, reply, 'read')) return;
    const account = loadAccount(req.params.accountId, req);
    if (!account) return reply.code(404).send({ error: 'Unknown account' });
    const raw = await providerFor(account.provider).getMessageRaw(
      account.id,
      req.params.messageId,
    );
    if (req.query.format === 'raw') {
      return reply.type('message/rfc822').send(raw);
    }
    const parsed = await simpleParser(raw);
    return {
      id: req.params.messageId,
      from: parsed.from?.text ?? null,
      to: Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(', ') : parsed.to?.text ?? null,
      cc: Array.isArray(parsed.cc) ? parsed.cc.map((t) => t.text).join(', ') : parsed.cc?.text ?? null,
      subject: parsed.subject ?? null,
      date: parsed.date?.toISOString() ?? null,
      messageId: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      text: parsed.text ?? null,
      html: parsed.html || null,
      attachments: parsed.attachments.map((a, index) => ({
        id: String(index),
        filename: a.filename ?? `attachment-${index}`,
        contentType: a.contentType,
        size: a.size,
      })),
    };
  });

  app.get<{ Params: { accountId: string; messageId: string; attachmentId: string } }>(
    '/accounts/:accountId/messages/:messageId/attachments/:attachmentId',
    async (req, reply) => {
      if (!requireScope(req, reply, 'read')) return;
      const account = loadAccount(req.params.accountId, req);
      if (!account) return reply.code(404).send({ error: 'Unknown account' });
      const raw = await providerFor(account.provider).getMessageRaw(
        account.id,
        req.params.messageId,
      );
      const parsed = await simpleParser(raw);
      const index = Number(req.params.attachmentId);
      const attachment = Number.isInteger(index) ? parsed.attachments[index] : undefined;
      if (!attachment) return reply.code(404).send({ error: 'Unknown attachment' });
      return reply
        .type(attachment.contentType || 'application/octet-stream')
        .header(
          'Content-Disposition',
          `attachment; filename="${(attachment.filename ?? 'attachment').replaceAll('"', '')}"`,
        )
        .send(attachment.content);
    },
  );
}
