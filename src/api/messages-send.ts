import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { enqueueSend } from '../queue/sendQueue.js';
import { providerFor } from '../providers/index.js';
import { loadAccount, requireScope } from './plugin.js';

const addressList = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

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

      return reply.code(202).send({
        jobId: job.id,
        status: job.status,
        statusUrl: `/api/v1/accounts/${account.id}/send-jobs/${job.id}`,
      });
    },
  );
}
