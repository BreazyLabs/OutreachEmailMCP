/**
 * The detector learns where every warmup message landed and turns that into
 * the recipient's behaviour: read it, star it, send a receipt, reply,
 * forward, rescue it from spam, tidy it away later.
 *
 * Three feeds: the inbound poller (INBOX arrivals), a periodic Spam sweep,
 * and a missing sweep for mail that never showed up anywhere.
 */

import { eq, and, asc, sql } from 'drizzle-orm';
import { simpleParser, type ParsedMail } from 'mailparser';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { logActivity } from '../observability/activity.js';
import { providerFor } from '../providers/index.js';
import { isMessageGone } from '../providers/errors.js';
import { normalizeMessageId } from '../inbound/classify.js';
import { isWarmupMessage, lookupRegistry } from './identity.js';
import { landingFor, updateLanding, markMissing } from './ledger.js';
import { enqueueTask } from './tasks.js';
import { rngFrom, type Rng } from './rng.js';
import { loadPool, memberById, type PoolMember } from './pool.js';
import { applyReputation } from './reputation.js';
import { emitWarmupEvent } from './events.js';
import { localDate, localMinutes, localToInstant, parseHHMM, shiftDate, weekdayOf } from './clock.js';
import type { WarmupSettings } from './settings.js';
import type { Account, WarmupLanding, WarmupMessage } from '../db/schema.js';

export interface InboundVerdict {
  /** Recognised as warmup traffic (ours, or a partner's rewritten copy). */
  warmup: boolean;
  /** A message that is NOT warmup but sits on a warmup thread: a person
   *  replied. Real mail, shown to consumers, but never correlated as a
   *  campaign reply and the thread is closed. */
  humanOnWarmupThread: boolean;
}

function headerOf(parsed: ParsedMail): (name: string) => string | null {
  return (name) => {
    const v = parsed.headers.get(name.toLowerCase());
    if (!v) return null;
    if (typeof v === 'string') return v;
    const asAny = v as { text?: string };
    return typeof asAny.text === 'string' ? asAny.text : String(v);
  };
}

const MINUTE = 60_000;

/** Log-uniform delay between min and max minutes: short delays are common,
 *  long ones happen. */
function delayMinutes(rng: Rng, min: number, max: number): number {
  const lo = Math.log(Math.max(1, min));
  const hi = Math.log(Math.max(min + 1, max));
  return Math.exp(lo + rng.next() * (hi - lo));
}

/**
 * Move an instant forward into the mailbox's send window and weekday rules,
 * so nothing a mailbox "writes" goes out at 03:00 on a Sunday.
 */
export function snapIntoWindow(at: number, settings: WarmupSettings, rng: Rng): number {
  const tz = settings.timezone;
  const start = parseHHMM(settings.sendWindowStart);
  const end = parseHHMM(settings.sendWindowEnd);
  let t = at;
  for (let i = 0; i < 8; i++) {
    const date = localDate(t, tz);
    const minutes = localMinutes(t, tz);
    const weekday = weekdayOf(date);
    const weekend = weekday === 0 || weekday === 6;
    if (weekend && settings.weekdaysOnly) {
      t = localToInstant(shiftDate(date, 1), start, tz) + rng.int(5, 90) * MINUTE;
      continue;
    }
    if (minutes < start) return localToInstant(date, start, tz) + rng.int(3, 75) * MINUTE + rng.int(0, 59_000);
    if (minutes >= end) {
      t = localToInstant(shiftDate(date, 1), start, tz) + rng.int(5, 90) * MINUTE;
      continue;
    }
    return t;
  }
  return t;
}

function threadOf(threadId: string) {
  return db.select().from(schema.warmupThreads).where(eq(schema.warmupThreads.id, threadId)).get();
}

/**
 * Given a landing that is now in the inbox (arrived there, was rescued, or
 * had its category fixed), schedule what this mailbox does with it.
 * Idempotent through task keys.
 */
export function scheduleEngagement(
  landing: WarmupLanding,
  message: WarmupMessage,
  receiver: PoolMember,
  now = Date.now(),
): void {
  const s = receiver.settings;
  const rng = rngFrom('engage', landing.id);
  const base = now;
  const accountId = receiver.account.id;
  const common = { accountId, counterpartyAccountId: message.fromAccountId };

  if (!receiver.canWrite) {
    // Without write scope the mailbox can still reply — that needs no
    // upstream change — but reads, stars and moves are impossible.
    logger.debug({ account: receiver.account.email }, 'warmup: no write scope, reply-only engagement');
  }

  const isCategory = landing.landed !== null && landing.landed !== 'inbox' && landing.landed !== 'spam';
  if (isCategory && s.fixCategory && receiver.canWrite && !landing.categoryFixedAt) {
    enqueueTask({
      ...common,
      kind: 'fix_category',
      dueAt: base + rng.int(1, 12) * MINUTE,
      idempotencyKey: `fixcat:${landing.id}`,
      payload: { landingId: landing.id },
    });
  }

  const willRead = rng.chance(s.readRate) || message.kind === 'mdn';
  if (!willRead) {
    scheduleCleanup(landing, receiver, rng, base);
    return;
  }
  const readAt = base + delayMinutes(rng, s.readDelayMinMinutes, s.readDelayMaxMinutes) * MINUTE;
  if (receiver.canWrite) {
    enqueueTask({
      ...common,
      kind: 'mark_read',
      dueAt: readAt,
      idempotencyKey: `read:${landing.id}`,
      payload: { landingId: landing.id },
    });
  }
  if (message.kind === 'mdn') {
    scheduleCleanup(landing, receiver, rng, base);
    return;
  }

  if (message.requestedReceipt && rng.chance(s.readReceiptSendRate)) {
    enqueueTask({
      ...common,
      kind: 'send_mdn',
      dueAt: readAt + rng.int(0, 3) * MINUTE + rng.int(0, 59_000),
      idempotencyKey: `mdn:${landing.id}`,
      payload: { landingId: landing.id, messageId: message.id },
    });
  }
  if (receiver.canWrite && rng.chance(s.starRate)) {
    enqueueTask({
      ...common,
      kind: 'star',
      dueAt: readAt + rng.int(0, 30) * MINUTE,
      idempotencyKey: `star:${landing.id}`,
      payload: { landingId: landing.id },
    });
  }
  if (receiver.canWrite && rng.chance(s.markImportantRate)) {
    enqueueTask({
      ...common,
      kind: 'mark_important',
      dueAt: readAt + rng.int(0, 20) * MINUTE,
      idempotencyKey: `important:${landing.id}`,
      payload: { landingId: landing.id },
    });
  }

  const thread = threadOf(message.threadId);
  const threadOpen =
    thread && thread.state === 'active' && !thread.humanRepliedAt && thread.turnsDone < thread.turnsPlanned;
  if (threadOpen && rng.chance(s.replyRate)) {
    const median = Math.sqrt(s.replyDelayMinMinutes * s.replyDelayMaxMinutes);
    const delay = Math.min(
      s.replyDelayMaxMinutes,
      Math.max(s.replyDelayMinMinutes, rng.logNormal(median, 0.7)),
    );
    const dueAt = snapIntoWindow(readAt + delay * MINUTE, s, rng);
    enqueueTask({
      ...common,
      kind: 'send_reply',
      dueAt,
      idempotencyKey: `reply:${landing.id}`,
      payload: { landingId: landing.id, messageId: message.id, threadId: message.threadId },
    });
  }
  if (
    thread &&
    thread.kind === 'conversation' &&
    (message.kind === 'open' || message.kind === 'reply') &&
    rng.chance(s.forwardRate)
  ) {
    const dueAt = snapIntoWindow(readAt + rng.int(5, 240) * MINUTE, s, rng);
    enqueueTask({
      ...common,
      kind: 'send_forward',
      dueAt,
      idempotencyKey: `fwd:${landing.id}`,
      payload: { landingId: landing.id, messageId: message.id, threadId: message.threadId },
    });
  }
  scheduleCleanup(landing, receiver, rng, base);
}

function scheduleCleanup(landing: WarmupLanding, receiver: PoolMember, rng: Rng, base: number): void {
  const s = receiver.settings;
  if (s.cleanupMode === 'none' || !receiver.canWrite || landing.cleanedAt) return;
  // Not every message, and not on a fixed day: somewhere in the window.
  if (!rng.chance(s.cleanupRate)) return;
  const days = s.cleanupAfterDays + rng.next() * Math.max(0, s.cleanupMaxDays - s.cleanupAfterDays);
  enqueueTask({
    accountId: receiver.account.id,
    counterpartyAccountId: landing.fromAccountId,
    kind: 'cleanup',
    dueAt: base + days * 24 * 3600_000 + rng.int(0, 14 * 60) * MINUTE,
    idempotencyKey: `cleanup:${landing.id}`,
    payload: { landingId: landing.id },
  });
}

function bareSubject(subject: string | null | undefined): string {
  return (subject ?? '').replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '').trim().toLowerCase();
}

/**
 * Marker-free identification: a message from a pool mailbox to this pool
 * mailbox whose subject matches a registry message that was sent to it in
 * the last two days and has not landed yet. Covers a provider rewriting the
 * Message-ID, since the mail carries no other marker on purpose.
 */
function matchUnmarkedWarmup(
  account: Account,
  parsed: ParsedMail,
  opts: { includeMissing?: boolean } = {},
): WarmupMessage | undefined {
  const fromAddress = parsed.from?.value?.[0]?.address?.toLowerCase();
  if (!fromAddress) return undefined;
  const sender = db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.email, fromAddress))
    .get();
  if (!sender) return undefined;
  const subject = bareSubject(parsed.subject);
  const since = Date.now() - 2 * 24 * 3600_000;
  const candidates = db
    .select({ message: schema.warmupMessages, landing: schema.warmupLandings })
    .from(schema.warmupLandings)
    .innerJoin(schema.warmupMessages, eq(schema.warmupMessages.id, schema.warmupLandings.messageId))
    .where(
      and(
        eq(schema.warmupLandings.toAccountId, account.id),
        eq(schema.warmupMessages.fromAccountId, sender.id),
        opts.includeMissing
          ? sql`(${schema.warmupLandings.landed} IS NULL OR ${schema.warmupLandings.landed} = 'missing')`
          : sql`${schema.warmupLandings.landed} IS NULL`,
        sql`${schema.warmupMessages.sentAt} > ${since}`,
      ),
    )
    .all();
  return candidates.find((c) => bareSubject(c.message.subject) === subject)?.message;
}

/** Record where a message landed for this recipient (first verdict wins). */
export function recordLanding(
  landing: WarmupLanding,
  landed: NonNullable<WarmupLanding['landed']>,
  providerMessageId: string | null,
  now = Date.now(),
): WarmupLanding {
  const patch: Partial<WarmupLanding> = {};
  if (!landing.landed) {
    patch.landed = landed;
    patch.landedAt = now;
  }
  if (providerMessageId && landing.providerMessageId !== providerMessageId) {
    patch.providerMessageId = providerMessageId;
  }
  if (Object.keys(patch).length) updateLanding(landing.id, patch);
  return { ...landing, ...patch };
}

function isDispositionNotification(raw: string, parsed: ParsedMail): boolean {
  const headerEnd = raw.indexOf('\r\n\r\n') >= 0 ? raw.indexOf('\r\n\r\n') : raw.indexOf('\n\n');
  const headers = headerEnd > 0 ? raw.slice(0, headerEnd) : raw.slice(0, 4000);
  if (/report-type=["']?disposition-notification/i.test(headers)) return true;
  if (/content-type:\s*message\/disposition-notification/i.test(raw)) return true;
  // Google Workspace read receipts are plain messages titled "Read: <subject>"
  // with Auto-Submitted set; Outlook's are "Read:" / "Gelezen:" and similar.
  const subject = parsed.subject ?? '';
  const auto = String(parsed.headers.get('auto-submitted') ?? '');
  return /^(read|gelezen|lu|gelesen|leído|letto|not read|niet gelezen):/i.test(subject) && (auto !== '' || /disposition/i.test(raw));
}

/** A message whose provider id we already attributed to one of our landings
 *  is ours, whatever its headers say now (a re-emitted delta item, or a
 *  provider that rewrote the Message-ID after we first saw it). */
function landingByProviderId(accountId: string, providerMessageId: string): WarmupLanding | undefined {
  return db
    .select()
    .from(schema.warmupLandings)
    .where(
      and(
        eq(schema.warmupLandings.toAccountId, accountId),
        eq(schema.warmupLandings.providerMessageId, providerMessageId),
      ),
    )
    .get();
}

/**
 * Poller hook: called for every new INBOX message before webhooks fire.
 */
export async function onInboundMessage(
  account: Account,
  providerMessageId: string,
  parsed: ParsedMail,
  raw: Buffer,
  now = Date.now(),
): Promise<InboundVerdict> {
  let identity = isWarmupMessage({
    messageId: parsed.messageId ?? null,
    header: headerOf(parsed),
    subject: parsed.subject ?? null,
    text: parsed.text ?? null,
  });
  if (!identity.warmup) {
    const known = landingByProviderId(account.id, providerMessageId);
    if (known) return { warmup: true, humanOnWarmupThread: false };
    const unmarked = matchUnmarkedWarmup(account, parsed);
    if (unmarked) identity = { warmup: true, via: 'registry', message: unmarked };
  }

  if (!identity.warmup) {
    // Not ours — but is it on one of our threads?
    const parentId = normalizeMessageId(parsed.inReplyTo ?? null);
    const parent = parentId ? lookupRegistry(parentId) : undefined;
    if (!parent) return { warmup: false, humanOnWarmupThread: false };
    if (isDispositionNotification(raw.toString(), parsed)) {
      // A partner's real mail client sent a read receipt for our message:
      // system noise on a warmup thread, hide it.
      return { warmup: true, humanOnWarmupThread: false };
    }
    db.update(schema.warmupThreads)
      .set({ state: 'abandoned', humanRepliedAt: now, updatedAt: now })
      .where(eq(schema.warmupThreads.id, parent.threadId))
      .run();
    logActivity({
      category: 'warmup',
      action: 'human-reply',
      status: 'ok',
      accountId: account.id,
      detail: `A person replied on warmup thread "${parent.subject}"; thread closed, message left visible`,
    });
    return { warmup: false, humanOnWarmupThread: true };
  }

  const message = identity.message;
  if (!message) {
    // Recognised by header/tag only (id rewritten in transit): hide it, but
    // there is no landing row to attribute it to.
    logger.debug({ account: account.email, via: identity.via }, 'warmup message recognised without registry row');
    return { warmup: true, humanOnWarmupThread: false };
  }

  const landing = landingFor(message.id, account.id);
  if (!landing) {
    // Our own copy showing up (e.g. a Cc to ourselves, or Gmail threading a
    // sent message into INBOX) — nothing to record.
    return { warmup: true, humanOnWarmupThread: false };
  }
  if (landing.landed && landing.landed !== 'spam' && landing.landed !== 'missing') {
    if (!landing.providerMessageId) updateLanding(landing.id, { providerMessageId });
    return { warmup: true, humanOnWarmupThread: false };
  }

  let landed: NonNullable<WarmupLanding['landed']> = 'inbox';
  try {
    const placement = await providerFor(account.provider).getMessagePlacement(account.id, providerMessageId);
    if (placement.inSpam) landed = 'spam';
    else if (placement.category && placement.category !== 'primary') landed = placement.category;
  } catch (err) {
    logger.debug({ account: account.email, err: String(err) }, 'warmup placement lookup failed; assuming inbox');
  }

  if (landing.landed === 'spam' || landing.landed === 'missing') {
    // Turned up after all (rescued and polled, or a late arrival).
    updateLanding(landing.id, { providerMessageId });
    if (landing.landed === 'missing') {
      updateLanding(landing.id, { landed, landedAt: now });
    }
    return { warmup: true, humanOnWarmupThread: false };
  }

  const recorded = recordLanding(landing, landed, providerMessageId, now);
  logActivity({
    category: 'warmup',
    action: landed === 'inbox' ? 'landed-inbox' : `landed-${landed}`,
    status: landed === 'inbox' ? 'ok' : 'failed',
    accountId: message.fromAccountId,
    detail: `"${message.subject}" → ${account.email}`,
  });

  const pool = loadPool();
  const receiver = memberById(pool, account.id);
  if (receiver) {
    if (landed === 'spam') {
      scheduleRescue(recorded, message, receiver, pool, now);
    } else {
      scheduleEngagement(recorded, message, receiver, now);
    }
  }
  return { warmup: true, humanOnWarmupThread: false };
}

function scheduleRescue(
  landing: WarmupLanding,
  message: WarmupMessage,
  receiver: PoolMember,
  pool: PoolMember[],
  now: number,
): void {
  const s = receiver.settings;
  const rng = rngFrom('rescue', landing.id);
  const sender = memberById(pool, message.fromAccountId);
  logger.warn(
    { from: sender?.account.email, to: receiver.account.email, subject: message.subject },
    'warmup message landed in spam',
  );
  if (sender) {
    emitWarmupEvent(sender.account, 'warmup.spam_detected', {
      subject: message.subject,
      recipient: receiver.account.email,
      willRescue: rng.chance(s.spamRescueRate),
    });
    applyReputation(sender, now, 'spam');
  }
  if (!receiver.canWrite || !rng.chance(s.spamRescueRate)) {
    scheduleCleanup(landing, receiver, rng, now);
    return;
  }
  enqueueTask({
    accountId: receiver.account.id,
    counterpartyAccountId: message.fromAccountId,
    kind: 'rescue',
    dueAt: now + delayMinutes(rng, Math.max(1, s.rescueDelayMinMinutes), Math.max(2, s.rescueDelayMaxMinutes)) * MINUTE,
    idempotencyKey: `rescue:${landing.id}`,
    payload: { landingId: landing.id, messageId: message.id },
  });
}

// --- Spam sweep ---------------------------------------------------------------

const SEEN_CAP = 300;

function parseSeen(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/** List the Spam folder once and record any of our messages found there. */
export async function sweepSpam(member: PoolMember, pool: PoolMember[], now = Date.now()): Promise<number> {
  const { account } = member;
  const provider = providerFor(account.provider);
  const ids = await provider.listMessageIds(account.id, 'Spam', 50);
  const seen = new Set(parseSeen(member.warm.spamSeenJson));
  const fresh = ids.filter((id) => !seen.has(id)).slice(0, 20);
  let found = 0;
  for (const id of fresh) {
    try {
      const raw = await provider.getMessageRaw(account.id, id);
      const parsed = await simpleParser(raw);
      let identity = isWarmupMessage({
        messageId: parsed.messageId ?? null,
        header: headerOf(parsed),
        subject: parsed.subject ?? null,
        text: parsed.text ?? null,
      });
      if (!identity.warmup) {
        // Same fallback as the inbox path: a provider may have rewritten
        // the Message-ID, and a message in Spam is exactly the one we most
        // need to recognise.
        const unmarked = matchUnmarkedWarmup(account, parsed, { includeMissing: true });
        if (unmarked) identity = { warmup: true, via: 'registry', message: unmarked };
      }
      if (!identity.warmup || !identity.message) continue;
      const message = identity.message;
      const landing = landingFor(message.id, account.id);
      if (!landing || (landing.landed && landing.landed !== 'missing')) continue;
      const recorded = recordLanding(
        landing.landed === 'missing' ? { ...landing, landed: null } : landing,
        'spam',
        id,
        now,
      );
      if (landing.landed === 'missing') updateLanding(landing.id, { landed: 'spam', landedAt: now });
      found++;
      logActivity({
        category: 'warmup',
        action: 'landed-spam',
        status: 'failed',
        accountId: message.fromAccountId,
        detail: `"${message.subject}" → ${account.email} (Spam)`,
      });
      scheduleRescue(recorded, message, member, pool, now);
    } catch (err) {
      if (isMessageGone(err)) continue;
      logger.warn({ account: account.email, id, err: String(err) }, 'warmup spam sweep: message fetch failed');
    }
  }
  const nextSeen = [...ids, ...[...seen].filter((s) => !ids.includes(s))].slice(0, SEEN_CAP);
  db.update(schema.warmupAccounts)
    .set({ lastSpamSweepAt: now, spamSeenJson: JSON.stringify(nextSeen), updatedAt: now })
    .where(eq(schema.warmupAccounts.accountId, account.id))
    .run();
  return found;
}

let sweeping = false;

/** Every tick, sweep the few members that are due; spread over the interval. */
export async function spamSweepTick(now = Date.now()): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const pool = loadPool();
    const due = pool
      .filter(
        (m) =>
          m.account.status === 'active' &&
          m.warm.state !== 'off' &&
          (m.warm.lastSpamSweepAt ?? 0) < now - config.WARMUP_SPAM_SWEEP_SECONDS * 1000,
      )
      .sort((a, b) => (a.warm.lastSpamSweepAt ?? 0) - (b.warm.lastSpamSweepAt ?? 0))
      .slice(0, 3);
    for (const member of due) {
      try {
        await sweepSpam(member, pool, now);
      } catch (err) {
        db.update(schema.warmupAccounts)
          .set({ lastSpamSweepAt: now, updatedAt: now })
          .where(eq(schema.warmupAccounts.accountId, member.account.id))
          .run();
        logActivity({
          category: 'warmup',
          action: 'spam-sweep',
          status: 'failed',
          accountId: member.account.id,
          error: String(err),
        });
      }
    }
  } finally {
    sweeping = false;
  }
}

/** Sent, past deadline, seen nowhere. */
export function missingSweepTick(now = Date.now()): number {
  const n = markMissing(now);
  if (n > 0) {
    // Missing placements feed the throttle just like spam.
    const pool = loadPool();
    for (const member of pool) applyReputation(member, now, 'spam');
  }
  return n;
}

/** Ordered Message-IDs of a thread, for the References header. */
export function threadReferences(threadId: string): string[] {
  return db
    .select({ id: schema.warmupMessages.rfcMessageId, kind: schema.warmupMessages.kind })
    .from(schema.warmupMessages)
    .where(and(eq(schema.warmupMessages.threadId, threadId)))
    .orderBy(asc(schema.warmupMessages.createdAt))
    .all()
    .filter((r) => r.kind !== 'mdn')
    .map((r) => `<${r.id}>`);
}
