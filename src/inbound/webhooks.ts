import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { db, sqlite, schema } from '../db/index.js';
import { decryptSecret } from '../crypto/secrets.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { backoffMs } from '../queue/sendQueue.js';
import type { WebhookDelivery } from '../db/schema.js';

const MAX_DELIVERY_ATTEMPTS = 6;
const deliveryEvents = new EventEmitter();

export interface MessageReceivedPayload {
  event: 'message.received';
  account: { id: string; email: string; provider: string };
  message: {
    id: string;
    from: string | null;
    to: string | null;
    subject: string | null;
    date: string | null;
    snippet: string | null;
    hasAttachments: boolean;
  };
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7));
  return (
    lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') ||
    lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')
  );
}

export async function isPrivateWebhookTarget(url: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return true;
  }
  if (net.isIP(host)) return isPrivateIp(host);
  try {
    const results = await dns.lookup(host, { all: true });
    return results.length === 0 || results.some((r) => isPrivateIp(r.address));
  } catch {
    return true;
  }
}

// Fan an event out to every matching webhook (scoped to the account's org)
// as a persisted delivery row.
export function dispatchEvent(payload: MessageReceivedPayload, orgId: string): number {
  const hooks = db
    .select()
    .from(schema.webhooks)
    .where(eq(schema.webhooks.active, 1))
    .all()
    .filter((w) => w.orgId === orgId)
    .filter((w) => (w.accountId === null || w.accountId === payload.account.id))
    .filter((w) => (JSON.parse(w.events) as string[]).includes(payload.event));
  const now = Date.now();
  for (const hook of hooks) {
    db.insert(schema.webhookDeliveries)
      .values({
        id: nanoid(),
        webhookId: hook.id,
        event: payload.event,
        payloadJson: JSON.stringify(payload),
        status: 'pending',
        nextAttemptAt: now,
        createdAt: now,
      })
      .run();
  }
  if (hooks.length > 0) deliveryEvents.emit('enqueued');
  return hooks.length;
}

function claimDeliveries(limit = 10): WebhookDelivery[] {
  const rows = sqlite
    .prepare(
      `UPDATE webhook_deliveries SET status = 'delivering', locked_at = @now
       WHERE id IN (
         SELECT id FROM webhook_deliveries
         WHERE status = 'pending' AND next_attempt_at <= @now
         ORDER BY next_attempt_at LIMIT @limit
       )
       RETURNING *`,
    )
    .all({ now: Date.now(), limit }) as Record<string, unknown>[];
  return rows.map(
    (r) =>
      ({
        id: r.id,
        webhookId: r.webhook_id,
        event: r.event,
        payloadJson: r.payload_json,
        status: r.status,
        attempts: r.attempts,
        nextAttemptAt: r.next_attempt_at,
        lockedAt: r.locked_at,
        responseStatus: r.response_status,
        lastError: r.last_error,
        createdAt: r.created_at,
        deliveredAt: r.delivered_at,
      }) as WebhookDelivery,
  );
}

async function deliverOne(delivery: WebhookDelivery): Promise<void> {
  const hook = db
    .select()
    .from(schema.webhooks)
    .where(eq(schema.webhooks.id, delivery.webhookId))
    .get();
  const fail = (error: string, responseStatus: number | null) => {
    const attempts = delivery.attempts + 1;
    const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
    db.update(schema.webhookDeliveries)
      .set({
        status: exhausted ? 'failed' : 'pending',
        attempts,
        nextAttemptAt: Date.now() + backoffMs(attempts),
        lockedAt: null,
        responseStatus,
        lastError: error.slice(0, 500),
      })
      .where(eq(schema.webhookDeliveries.id, delivery.id))
      .run();
  };
  if (!hook || !hook.active) {
    db.update(schema.webhookDeliveries)
      .set({ status: 'failed', lastError: 'Webhook removed or inactive', lockedAt: null })
      .where(eq(schema.webhookDeliveries.id, delivery.id))
      .run();
    return;
  }
  if (!config.WEBHOOKS_ALLOW_PRIVATE && (await isPrivateWebhookTarget(hook.url))) {
    fail('Target resolves to a private address', null);
    return;
  }
  const body = delivery.payloadJson;
  const signature = crypto
    .createHmac('sha256', decryptSecret(hook.secretEnc))
    .update(body)
    .digest('hex');
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'OutreachEmailMCP-Webhooks/1.0',
        'X-OutreachEmailMCP-Event': delivery.event,
        'X-OutreachEmailMCP-Delivery': delivery.id,
        'X-OutreachEmailMCP-Signature': `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      db.update(schema.webhookDeliveries)
        .set({
          status: 'delivered',
          attempts: delivery.attempts + 1,
          responseStatus: res.status,
          lockedAt: null,
          deliveredAt: Date.now(),
          lastError: null,
        })
        .where(eq(schema.webhookDeliveries.id, delivery.id))
        .run();
    } else {
      fail(`HTTP ${res.status}`, res.status);
    }
  } catch (err) {
    fail(String(err), null);
  }
}

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const claimed = claimDeliveries();
      if (claimed.length === 0) break;
      await Promise.allSettled(claimed.map(deliverOne));
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'webhook delivery tick failed');
  } finally {
    running = false;
  }
}

export function startWebhookWorker(): () => void {
  // Recover deliveries stuck in 'delivering' from a previous crash
  sqlite
    .prepare(`UPDATE webhook_deliveries SET status = 'pending', locked_at = NULL WHERE status = 'delivering'`)
    .run();
  const interval = setInterval(tick, 2000);
  interval.unref();
  deliveryEvents.on('enqueued', tick);
  return () => {
    clearInterval(interval);
    deliveryEvents.off('enqueued', tick);
  };
}
