import { eq } from 'drizzle-orm';
import { simpleParser } from 'mailparser';
import { db, schema } from '../db/index.js';
import { providerFor } from '../providers/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { dispatchEvent } from './webhooks.js';
import { indexMessage } from '../imap/index-store.js';
import type { Account } from '../db/schema.js';

async function pollAccount(account: Account): Promise<void> {
  const provider = providerFor(account.provider);
  const state = db
    .select()
    .from(schema.syncState)
    .where(eq(schema.syncState.accountId, account.id))
    .get();

  let cursor = state?.cursor ?? null;
  if (!cursor) {
    cursor = await provider.initCursor(account.id);
    db.insert(schema.syncState)
      .values({ accountId: account.id, cursor, lastPolledAt: Date.now(), lastError: null })
      .onConflictDoUpdate({
        target: schema.syncState.accountId,
        set: { cursor, lastPolledAt: Date.now(), lastError: null },
      })
      .run();
    return; // first poll only anchors; new mail picked up next tick
  }

  const { newMessageIds, nextCursor } = await provider.pollChanges(account.id, cursor);
  // Cap per tick so a burst (or a re-anchor glitch) can't flood webhook targets
  const ids = newMessageIds.slice(0, 50);
  for (const messageId of ids) {
    try {
      const raw = await provider.getMessageRaw(account.id, messageId);
      const parsed = await simpleParser(raw);
      indexMessage(account.id, messageId, raw, parsed);
      const count = dispatchEvent(
        {
          event: 'message.received',
          account: { id: account.id, email: account.email, provider: account.provider },
          message: {
            id: messageId,
            from: parsed.from?.text ?? null,
            to: Array.isArray(parsed.to)
              ? parsed.to.map((t) => t.text).join(', ')
              : parsed.to?.text ?? null,
            subject: parsed.subject ?? null,
            date: parsed.date?.toISOString() ?? null,
            snippet: (parsed.text ?? '').trim().slice(0, 200) || null,
            hasAttachments: parsed.attachments.length > 0,
          },
        },
        account.orgId,
      );
      logger.info(
        { account: account.email, messageId, webhooks: count },
        'new inbound message',
      );
    } catch (err) {
      logger.warn(
        { account: account.email, messageId, err: String(err) },
        'failed to process inbound message',
      );
    }
  }

  db.update(schema.syncState)
    .set({ cursor: nextCursor, lastPolledAt: Date.now(), lastError: null })
    .where(eq(schema.syncState.accountId, account.id))
    .run();
}

// On-demand refresh for IMAP SELECT/NOOP so mailbox state is fresher than the
// poll interval; rate-limited per account.
const lastRefresh = new Map<string, number>();
export async function refreshAccountMailbox(account: Account, minIntervalMs = 15_000): Promise<void> {
  const last = lastRefresh.get(account.id) ?? 0;
  if (Date.now() - last < minIntervalMs) return;
  lastRefresh.set(account.id, Date.now());
  await pollAccount(account);
}

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const accounts = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.status, 'active'))
      .all();
    for (const account of accounts) {
      try {
        await pollAccount(account);
      } catch (err) {
        db.update(schema.syncState)
          .set({ lastPolledAt: Date.now(), lastError: String(err).slice(0, 500) })
          .where(eq(schema.syncState.accountId, account.id))
          .run();
        logger.warn({ account: account.email, err: String(err) }, 'inbound poll failed');
      }
    }
  } finally {
    running = false;
  }
}

export function startInboundPoller(): () => void {
  const interval = setInterval(tick, config.POLL_INTERVAL * 1000);
  interval.unref();
  logger.info({ intervalSeconds: config.POLL_INTERVAL }, 'inbound poller started');
  return () => clearInterval(interval);
}
