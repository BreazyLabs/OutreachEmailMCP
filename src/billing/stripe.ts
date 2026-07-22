import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { requireUiSession, verifyCsrf } from '../ui/session.js';

// Minimal Stripe integration over plain fetch — one subscription price
// (STRIPE_PRICE_PRO), Checkout for upgrade, Billing Portal for management,
// and a signature-verified webhook to sync plan state. No SDK dependency.

const STRIPE_API = 'https://api.stripe.com/v1';

async function stripeRequest(
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = body.error as { message?: string } | undefined;
    throw new Error(`Stripe ${path}: ${err?.message ?? res.status}`);
  }
  return body;
}

// Stripe-Signature: t=<ts>,v1=<hmac>,... — HMAC-SHA256 of "<ts>.<payload>".
export function verifyStripeSignature(payload: Buffer, header: string, secret: string): boolean {
  const parts = new Map(
    header.split(',').map((p) => {
      const idx = p.indexOf('=');
      return [p.slice(0, idx), p.slice(idx + 1)] as const;
    }),
  );
  const timestamp = parts.get('t');
  const signature = parts.get('v1');
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false; // 5 min tolerance
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payload.toString('utf8')}`)
    .digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function registerBillingRoutes(app: FastifyInstance): void {
  if (!config.stripeEnabled) return;

  app.post('/ui/billing/checkout', async (req, reply) => {
    const session = requireUiSession(req, reply);
    if (!session) return;
    if (!verifyCsrf(req)) return reply.code(403).send('Invalid CSRF token');
    const base = config.BASE_URL.replace(/\/$/, '');
    const checkout = await stripeRequest('/checkout/sessions', {
      mode: 'subscription',
      'line_items[0][price]': config.STRIPE_PRICE_PRO!,
      'line_items[0][quantity]': '1',
      client_reference_id: session.org.id,
      customer_email: session.user.email,
      success_url: `${base}/ui/billing`,
      cancel_url: `${base}/ui/billing`,
    });
    return reply.redirect(String(checkout.url));
  });

  app.post('/ui/billing/portal', async (req, reply) => {
    const session = requireUiSession(req, reply);
    if (!session) return;
    if (!verifyCsrf(req)) return reply.code(403).send('Invalid CSRF token');
    if (!session.org.stripeCustomerId) return reply.redirect('/ui/billing');
    const portal = await stripeRequest('/billing_portal/sessions', {
      customer: session.org.stripeCustomerId,
      return_url: `${config.BASE_URL.replace(/\/$/, '')}/ui/billing`,
    });
    return reply.redirect(String(portal.url));
  });

  // Isolated scope so the raw body survives for signature verification.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body),
    );
    scope.post('/billing/stripe/webhook', async (req, reply) => {
      const payload = req.body as Buffer;
      const signature = req.headers['stripe-signature'];
      if (
        typeof signature !== 'string' ||
        !verifyStripeSignature(payload, signature, config.STRIPE_WEBHOOK_SECRET!)
      ) {
        return reply.code(400).send({ error: 'Invalid signature' });
      }
      const event = JSON.parse(payload.toString('utf8')) as {
        type: string;
        data: { object: Record<string, unknown> };
      };
      const object = event.data.object;
      if (event.type === 'checkout.session.completed') {
        const orgId = String(object.client_reference_id ?? '');
        if (orgId) {
          db.update(schema.orgs)
            .set({
              plan: 'pro',
              stripeCustomerId: String(object.customer ?? '') || null,
              stripeSubscriptionId: String(object.subscription ?? '') || null,
            })
            .where(eq(schema.orgs.id, orgId))
            .run();
          logger.info({ orgId }, 'org upgraded to pro via stripe checkout');
        }
      } else if (
        event.type === 'customer.subscription.deleted' ||
        event.type === 'customer.subscription.paused'
      ) {
        const customer = String(object.customer ?? '');
        if (customer) {
          db.update(schema.orgs)
            .set({ plan: 'free', stripeSubscriptionId: null })
            .where(eq(schema.orgs.stripeCustomerId, customer))
            .run();
          logger.info({ customer }, 'org downgraded to free (subscription ended)');
        }
      }
      return { received: true };
    });
  });
}
