import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/index.js';
import { encryptSecret, decryptSecret } from '../crypto/secrets.js';
import { randomBase62 } from '../crypto/credentials.js';
import { isPrivateWebhookTarget } from '../inbound/webhooks.js';
import { config } from '../config.js';
import { loadAccount, orgOf, requireScope } from './plugin.js';
import type { Webhook } from '../db/schema.js';

const createSchema = z.object({
  url: z.string().url().startsWith('http'),
  accountId: z.string().optional(),
  events: z.array(z.enum(['message.received'])).min(1).default(['message.received']),
});

function publicWebhook(w: Webhook, includeSecret = false) {
  return {
    id: w.id,
    url: w.url,
    accountId: w.accountId,
    events: JSON.parse(w.events) as string[],
    active: Boolean(w.active),
    createdAt: w.createdAt,
    ...(includeSecret ? { secret: decryptSecret(w.secretEnc) } : {}),
  };
}

export function registerWebhookRoutes(app: FastifyInstance) {
  app.get('/webhooks', async (req, reply) => {
    if (!requireScope(req, reply, 'webhooks')) return;
    return db
      .select()
      .from(schema.webhooks)
      .where(eq(schema.webhooks.orgId, orgOf(req)))
      .orderBy(desc(schema.webhooks.createdAt))
      .all()
      .map((w) => publicWebhook(w));
  });

  app.post('/webhooks', async (req, reply) => {
      if (!requireScope(req, reply, 'webhooks')) return;
    const body = createSchema.parse(req.body);
    if (body.accountId && !loadAccount(body.accountId, req)) {
      return reply.code(404).send({ error: 'Unknown account' });
    }
    if (!config.WEBHOOKS_ALLOW_PRIVATE && (await isPrivateWebhookTarget(body.url))) {
      return reply.code(400).send({
        error:
          'Webhook target resolves to a private/loopback address. Set WEBHOOKS_ALLOW_PRIVATE=true to allow.',
      });
    }
    const secret = `whsec_${randomBase62(32)}`;
    const webhook = db
      .insert(schema.webhooks)
      .values({
        id: nanoid(),
        orgId: orgOf(req),
        accountId: body.accountId ?? null,
        url: body.url,
        secretEnc: encryptSecret(secret),
        events: JSON.stringify(body.events),
        active: 1,
        createdAt: Date.now(),
      })
      .returning()
      .get();
    return reply.code(201).send(publicWebhook(webhook, true));
  });

  app.get<{ Params: { webhookId: string } }>('/webhooks/:webhookId', async (req, reply) => {
      if (!requireScope(req, reply, 'webhooks')) return;
    const w = db
      .select()
      .from(schema.webhooks)
      .where(eq(schema.webhooks.id, req.params.webhookId))
      .get();
    if (!w || w.orgId !== orgOf(req)) return reply.code(404).send({ error: 'Unknown webhook' });
    return publicWebhook(w, true);
  });

  app.delete<{ Params: { webhookId: string } }>('/webhooks/:webhookId', async (req, reply) => {
      if (!requireScope(req, reply, 'webhooks')) return;
    const w = db
      .select()
      .from(schema.webhooks)
      .where(eq(schema.webhooks.id, req.params.webhookId))
      .get();
    if (!w || w.orgId !== orgOf(req)) return reply.code(404).send({ error: 'Unknown webhook' });
    db.delete(schema.webhooks).where(eq(schema.webhooks.id, w.id)).run();
    return { deleted: req.params.webhookId };
  });

  app.get<{ Params: { webhookId: string } }>(
    '/webhooks/:webhookId/deliveries',
    async (req, reply) => {
      if (!requireScope(req, reply, 'webhooks')) return;
      const w = db
        .select()
        .from(schema.webhooks)
        .where(eq(schema.webhooks.id, req.params.webhookId))
        .get();
      if (!w || w.orgId !== orgOf(req)) return reply.code(404).send({ error: 'Unknown webhook' });
      return db
        .select()
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.webhookId, w.id))
        .orderBy(desc(schema.webhookDeliveries.createdAt))
        .limit(100)
        .all()
        .map((d) => ({
          id: d.id,
          event: d.event,
          status: d.status,
          attempts: d.attempts,
          responseStatus: d.responseStatus,
          lastError: d.lastError,
          createdAt: d.createdAt,
          deliveredAt: d.deliveredAt,
        }));
    },
  );
}
