import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { enqueueSend, findRecentJobByMessageId } from '../queue/sendQueue.js';
import { providerFor } from '../providers/index.js';
import { logActivity } from '../observability/activity.js';
import { loadAccount, requireScope } from './plugin.js';

const addressList = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

/** An RFC 5322 msg-id, angle brackets included. */
const MESSAGE_ID_RE = /^<[^<>\s]+@[^<>\s]+>$/;
const messageIdField = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => MESSAGE_ID_RE.test(v), { message: 'must look like <local@domain>' });

const sendSchema = z
  .object({
    to: addressList,
    cc: addressList.optional(),
    bcc: addressList.optional(),
    replyTo: z.string().optional(),
    subject: z.string().default(''),
    text: z.string().optional(),
    html: z.string().optional(),
    headers: z.record(z.string()).optional(),
    /** Message-ID to stamp instead of a generated one, so the caller can
     *  correlate replies and bounces to its own records. */
    messageId: messageIdField.optional(),
    /** Threading: the Message-ID this is a reply to, and the chain. */
    inReplyTo: messageIdField.optional(),
    references: z.array(messageIdField).max(100).optional(),
    attachments: z
      .array(
        z.object({
          filename: z.string().min(1),
          contentType: z.string().optional(),
          contentBase64: z.string().min(1),
        }),
      )
      .max(50)
      .optional(),
  })
  .refine((v) => v.text !== undefined || v.html !== undefined, {
    message: 'Provide at least one of "text" or "html"',
  });

export function buildMime(mail: Mail.Options): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(mail).compile().build((err: Error | null, message: Buffer) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}

const toArray = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/** The Message-ID actually written into a built MIME, brackets included. */
export function messageIdOf(raw: Buffer | string): string | null {
  const head = raw.toString('utf8').split(/\r?\n\r?\n/)[0] ?? '';
  const m = /^Message-ID:\s*(<[^>]+>)/im.exec(head.replace(/\r?\n[ \t]+/g, ' '));
  return m?.[1] ?? null;
}

export function registerSendRoutes(app: FastifyInstance) {
  app.post<{ Params: { accountId: string } }>(
    '/accounts/:accountId/messages',
    async (req, reply) => {
      if (!requireScope(req, reply, 'send')) return;
      const account = loadAccount(req.params.accountId, req);
      if (!account) return reply.code(404).send({ error: 'Unknown account' });
      if (account.status === 'disabled') {
        return reply.code(409).send({ error: 'Account is disabled' });
      }

      const body = sendSchema.parse(req.body);
      const from = account.displayName
        ? `"${account.displayName.replaceAll('"', '')}" <${account.email}>`
        : account.email;

      const raw = await buildMime({
        from,
        to: toArray(body.to),
        cc: toArray(body.cc),
        bcc: toArray(body.bcc),
        replyTo: body.replyTo,
        subject: body.subject,
        text: body.text,
        html: body.html,
        headers: body.headers,
        // MailComposer copies these onto the root node after custom headers,
        // so they always win; nodemailer only generates a Message-ID when
        // none is set.
        ...(body.messageId ? { messageId: body.messageId } : {}),
        ...(body.inReplyTo ? { inReplyTo: body.inReplyTo } : {}),
        ...(body.references?.length ? { references: body.references } : {}),
        attachments: body.attachments?.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          content: Buffer.from(a.contentBase64, 'base64'),
        })),
      });

      const providerLimit = providerFor(account.provider).maxRawSize;
      if (raw.length > providerLimit) {
        return reply.code(413).send({
          error: `Message is ${raw.length} bytes; the ${account.provider} delivery limit is ${providerLimit} bytes`,
        });
      }

      // Idempotency: when the caller stamps its own Message-ID, a resubmission
      // of the same id (a retry after a client timeout or a crash between our
      // DB write and the 202) returns the first job instead of sending again.
      const writtenId = messageIdOf(raw);
      if (body.messageId && writtenId) {
        const existing = findRecentJobByMessageId(account.id, writtenId);
        if (existing) {
          return reply.code(202).send({
            jobId: existing.id,
            status: existing.status,
            messageId: existing.messageId,
            deduped: true,
            statusUrl: `/api/v1/accounts/${account.id}/send-jobs/${existing.id}`,
          });
        }
      }

      const job = enqueueSend({
        accountId: account.id,
        source: 'api',
        raw,
        envelope: {
          from: account.email,
          to: [...toArray(body.to), ...toArray(body.cc), ...toArray(body.bcc)],
        },
        subject: body.subject || null,
      });
      logActivity({
        category: 'api',
        action: 'submit',
        status: 'ok',
        accountId: account.id,
        detail: `job=${job.id} to=${toArray(body.to).join(',')} subject=${body.subject}`.slice(0, 400),
      });

      return reply.code(202).send({
        jobId: job.id,
        status: job.status,
        messageId: messageIdOf(raw),
        statusUrl: `/api/v1/accounts/${account.id}/send-jobs/${job.id}`,
      });
    },
  );
}
