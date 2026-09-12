/**
 * The executor claims due warmup tasks and performs them: open a
 * conversation, reply, forward, send a read receipt, or do the things a
 * mail client does to a received message (read, star, mark important,
 * rescue from spam, fix category, tidy away).
 */

import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { logActivity } from '../observability/activity.js';
import { providerFor } from '../providers/index.js';
import { AuthError, isMessageGone } from '../providers/errors.js';
import { enqueueSend } from '../queue/sendQueue.js';
import { rngFrom } from './rng.js';
import { localDate } from './clock.js';
import { orgTagIfEnabled, newWarmupMessageId } from './identity.js';
import {
  claimTasks,
  completeTask,
  failTask,
  skipTask,
  reapStuckTasks,
  skipStaleSendTasks,
} from './tasks.js';
import { loadPool, memberById, choosePartner, sharedLanguages, createdOnDate, type PoolMember } from './pool.js';
import { registerMessage, attachSendJob, landingById, updateLanding, messageById } from './ledger.js';
import { personaFor } from './state.js';
import { pickScript, markScriptUsed, scriptById, renderTurn, ackPhrase, forwardNote, forwardReply, spinSubject } from './content/scripts.js';
import {
  buildWarmupMime,
  buildMdnMime,
  quoteBlock,
  forwardBlock,
  replySubject,
  forwardSubject,
  styleFor,
  type Party,
  type OriginalMessage,
} from './mime.js';
import { scheduleEngagement, threadReferences } from './detector.js';
import { emitWarmupEvent } from './events.js';
import { fullName } from './content/persona.js';
import type { WarmupTask, WarmupThread } from '../db/schema.js';

const workerId = `warmup-${nanoid(8)}`;

class SkipTask extends Error {}

function partyFor(m: PoolMember): Party {
  return { email: m.account.email, persona: personaFor(m.account, m.warm), style: styleFor(m.account.provider) };
}

function threadById(id: string): WarmupThread | undefined {
  return db.select().from(schema.warmupThreads).where(eq(schema.warmupThreads.id, id)).get();
}

function participants(thread: WarmupThread): string[] {
  try {
    return JSON.parse(thread.participantsJson) as string[];
  } catch {
    return [thread.initiatorAccountId];
  }
}

/** Thread lengths skew short: 1 message is the most common "thread". */
function drawThreadLength(max: number, rng: ReturnType<typeof rngFrom>): number {
  const weights = [45, 30, 15, 7, 3, 1];
  const options = Array.from({ length: Math.min(max, weights.length) }, (_, i) => i + 1);
  return rng.weighted(options, (n) => weights[n - 1]!) ?? 1;
}

function todayFor(m: PoolMember): string {
  return localDate(Date.now(), m.settings.timezone);
}

/** Languages are listed most-used first: the first one wins about two
 *  thirds of the time so a Dutch pair mostly writes Dutch. */
function chooseLanguage(shared: string[], preferred: string | undefined, rng: ReturnType<typeof rngFrom>): string {
  if (shared.length === 0) return 'en';
  if (preferred && shared.includes(preferred) && rng.chance(66)) return preferred;
  return rng.pick(shared) ?? shared[0]!;
}

/** The daily caps are enforced here, against what was actually created
 *  today, never against the plan — so replans and retries cannot overshoot. */
function assertSendCapacity(m: PoolMember, kind: 'open' | 'reply' | 'forward'): void {
  const today = todayFor(m);
  const created = createdOnDate(m.account.id, today);
  const cap = kind === 'open' ? Math.max(0, m.warm.todayTarget) : m.settings.dailyLimit;
  if (created >= cap) throw new SkipTask(`Daily warmup cap reached (${created}/${cap})`);
}

async function queueWarmupSend(
  sender: PoolMember,
  raw: Buffer,
  to: string[],
  subject: string,
  warmupMessageId: string,
): Promise<void> {
  const providerLimit = providerFor(sender.account.provider).maxRawSize;
  if (raw.length > providerLimit) throw new Error(`Warmup message too large (${raw.length} bytes)`);
  const job = enqueueSend({
    accountId: sender.account.id,
    source: 'warmup',
    raw,
    envelope: { from: sender.account.email, to },
    subject,
    warmupMessageId,
  });
  attachSendJob(warmupMessageId, job.id);
}

// --- send_open ----------------------------------------------------------------

async function handleSendOpen(task: WarmupTask, payload: { partnerAccountId: string; ccAccountId: string | null; internal: boolean; requestReceipt: boolean; date: string; seq: number }): Promise<void> {
  const pool = loadPool();
  const me = memberById(pool, task.accountId);
  const partner = memberById(pool, payload.partnerAccountId);
  if (!me) throw new SkipTask('Sender is no longer in the pool');
  if (!partner || partner.account.status !== 'active' || partner.warm.state === 'off' || partner.warm.state === 'paused' || partner.warm.state === 'blocked_upstream') {
    throw new SkipTask('Partner is no longer available');
  }
  assertSendCapacity(me, 'open');
  const cc = payload.ccAccountId ? memberById(pool, payload.ccAccountId) : null;
  const ccOk = cc && cc.account.status === 'active' && cc.warm.state !== 'off' && cc.warm.state !== 'blocked_upstream';
  const rng = rngFrom('open', task.idempotencyKey);
  const language = chooseLanguage(sharedLanguages(me, partner), me.settings.languages[0], rng);
  const picked = pickScript(language, me.settings.register, rng);
  if (!picked) throw new SkipTask('No conversation scripts available');
  const { script, turns } = picked;
  const subject = spinSubject(script.subject, rng);
  const turnsPlanned = Math.max(1, Math.min(drawThreadLength(me.settings.maxThreadTurns, rng), me.settings.maxThreadTurns));

  const threadId = nanoid();
  const now = Date.now();
  const participantIds = [me.account.id, partner.account.id, ...(ccOk ? [cc!.account.id] : [])];
  db.insert(schema.warmupThreads)
    .values({
      id: threadId,
      kind: 'conversation',
      initiatorAccountId: me.account.id,
      participantsJson: JSON.stringify(participantIds),
      subject,
      scriptId: script.id,
      language,
      turnsPlanned,
      turnsDone: 0,
      state: 'active',
      internal: payload.internal ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const from = partyFor(me);
  const to = partyFor(partner);
  const tag = orgTagIfEnabled(me.org.id);
  const body = renderTurn(turns[0] ?? ackPhrase(language, rng), language, from.persona, to.persona, rng, {
    includeHtml: true,
    tag,
    lowercaseOpener: true,
  });
  const id = newWarmupMessageId(me.account.email, me.account.provider);
  const message = registerMessage({
    threadId,
    turn: 0,
    kind: 'open',
    fromAccountId: me.account.id,
    toAccountId: partner.account.id,
    ccAccountIds: ccOk ? [cc!.account.id] : [],
    rfcMessageId: id.normalized,
    subject,
    contentSource: script.source,
    requestedReceipt: payload.requestReceipt,
    localDate: todayFor(me),
  });
  db.update(schema.warmupMessages).set({ bodyText: body.text }).where(eq(schema.warmupMessages.id, message.id)).run();
  const raw = await buildWarmupMime({
    from,
    to: [to],
    cc: ccOk ? [partyFor(cc!)] : [],
    subject,
    text: body.text,
    html: body.html,
    messageIdHeader: id.header,
    normalizedMessageId: id.normalized,
    requestReceipt: payload.requestReceipt,
  });
  await queueWarmupSend(me, raw, [partner.account.email, ...(ccOk ? [cc!.account.email] : [])], subject, message.id);
  db.update(schema.warmupThreads).set({ turnsDone: 1, updatedAt: Date.now() }).where(eq(schema.warmupThreads.id, threadId)).run();
  markScriptUsed(script.id);
  logActivity({
    category: 'warmup',
    action: 'send-open',
    status: 'ok',
    accountId: me.account.id,
    detail: `"${subject}" → ${partner.account.email}${ccOk ? ` cc ${cc!.account.email}` : ''}${payload.internal ? ' (internal)' : ''}${payload.requestReceipt ? ' (receipt requested)' : ''}`,
  });
}

// --- send_reply -----------------------------------------------------------------

function originalFor(messageId: string, pool: PoolMember[]): { original: OriginalMessage } | null {
  const message = messageById(messageId);
  if (!message) return null;
  const sender = memberById(pool, message.fromAccountId);
  const senderAccount = sender?.account ?? db.select().from(schema.accounts).where(eq(schema.accounts.id, message.fromAccountId)).get();
  if (!senderAccount) return null;
  const toAccount = db.select().from(schema.accounts).where(eq(schema.accounts.id, message.toAccountId)).get();
  const persona = personaFor(senderAccount, sender?.warm);
  return {
    original: {
      fromName: fullName(persona),
      fromEmail: senderAccount.email,
      to: toAccount?.email ?? '',
      subject: message.subject,
      sentAt: message.sentAt ?? message.createdAt,
      text: message.bodyText ?? '',
    },
  };
}

async function handleSendReply(task: WarmupTask, payload: { landingId: string; messageId: string; threadId: string }): Promise<void> {
  const pool = loadPool();
  const me = memberById(pool, task.accountId);
  if (!me) throw new SkipTask('Replier is no longer in the pool');
  const thread = threadById(payload.threadId);
  if (!thread || thread.state !== 'active' || thread.humanRepliedAt) throw new SkipTask('Thread is closed');
  if (thread.turnsDone >= thread.turnsPlanned) throw new SkipTask('Thread reached its planned length');
  const original = messageById(payload.messageId);
  if (!original) throw new SkipTask('Original message vanished');
  assertSendCapacity(me, 'reply');
  const landing = landingById(payload.landingId);
  const rng = rngFrom('reply', task.idempotencyKey);
  const language = thread.language;

  const others = participants(thread).filter((id) => id !== me.account.id);
  const toMember = memberById(pool, original.fromAccountId);
  if (!toMember || toMember.account.status !== 'active') throw new SkipTask('Original sender is unavailable');
  const ccMembers = others
    .filter((id) => id !== original.fromAccountId)
    .map((id) => memberById(pool, id))
    .filter((m): m is PoolMember => !!m && m.account.status === 'active');

  const script = thread.scriptId ? scriptById(thread.scriptId) : undefined;
  const turns = script ? (JSON.parse(script.turnsJson) as string[]) : [];
  const turnIndex = thread.turnsDone;
  let text: string;
  let contentSource: 'llm' | 'template' | 'ack';
  if (thread.kind === 'forward') {
    text = forwardReply(language, rng);
    contentSource = 'ack';
  } else if (turns[turnIndex]) {
    text = turns[turnIndex]!;
    contentSource = script!.source;
  } else {
    text = ackPhrase(language, rng);
    contentSource = 'ack';
  }

  const from = partyFor(me);
  const to = partyFor(toMember);
  const tag = orgTagIfEnabled(me.org.id);
  const rendered = renderTurn(text, language, from.persona, to.persona, rng, { includeHtml: true, tag });
  const quoted = originalFor(original.id, pool);
  const quote = quoted ? quoteBlock(from.style, quoted.original) : null;
  const bodyText = quote ? `${rendered.text}\n${quote.text}` : rendered.text;
  const bodyHtml = rendered.html ? (quote ? `${rendered.html}<br>${quote.html}` : rendered.html) : null;

  const subject = replySubject(thread.subject);
  const id = newWarmupMessageId(me.account.email, me.account.provider);
  const references = threadReferences(thread.id);
  const inReplyTo = `<${original.rfcMessageId}>`;
  if (!references.includes(inReplyTo)) references.push(inReplyTo);
  const message = registerMessage({
    threadId: thread.id,
    turn: turnIndex,
    kind: 'reply',
    fromAccountId: me.account.id,
    toAccountId: toMember.account.id,
    ccAccountIds: ccMembers.map((m) => m.account.id),
    rfcMessageId: id.normalized,
    inReplyToMessageId: original.rfcMessageId,
    subject,
    contentSource,
    localDate: todayFor(me),
  });
  db.update(schema.warmupMessages).set({ bodyText: rendered.text }).where(eq(schema.warmupMessages.id, message.id)).run();
  const raw = await buildWarmupMime({
    from,
    to: [to],
    cc: ccMembers.map(partyFor),
    subject,
    text: bodyText,
    html: bodyHtml,
    messageIdHeader: id.header,
    normalizedMessageId: id.normalized,
    inReplyTo,
    references,
  });
  await queueWarmupSend(me, raw, [toMember.account.email, ...ccMembers.map((m) => m.account.email)], subject, message.id);
  const turnsDone = thread.turnsDone + 1;
  db.update(schema.warmupThreads)
    .set({ turnsDone, state: turnsDone >= thread.turnsPlanned ? 'done' : 'active', updatedAt: Date.now() })
    .where(eq(schema.warmupThreads.id, thread.id))
    .run();
  if (landing) updateLanding(landing.id, { repliedAt: Date.now() });
  logActivity({
    category: 'warmup',
    action: 'send-reply',
    status: 'ok',
    accountId: me.account.id,
    detail: `"${subject}" → ${toMember.account.email}${ccMembers.length ? ` cc ${ccMembers.map((m) => m.account.email).join(', ')}` : ''} (turn ${turnsDone}/${thread.turnsPlanned})`,
  });
}

// --- send_forward ---------------------------------------------------------------

async function handleSendForward(task: WarmupTask, payload: { landingId: string; messageId: string; threadId: string }): Promise<void> {
  const pool = loadPool();
  const me = memberById(pool, task.accountId);
  if (!me) throw new SkipTask('Forwarder is no longer in the pool');
  const sourceThread = threadById(payload.threadId);
  const original = messageById(payload.messageId);
  if (!sourceThread || !original) throw new SkipTask('Source thread vanished');
  assertSendCapacity(me, 'forward');
  const rng = rngFrom('forward', task.idempotencyKey);
  const exclude = new Set(participants(sourceThread));
  const recipient = choosePartner(me, pool, rng, { internal: rng.chance(50), exclude });
  if (!recipient) throw new SkipTask('No third mailbox available to forward to');
  const language = chooseLanguage(sharedLanguages(me, recipient), me.settings.languages[0], rng);
  const quoted = originalFor(original.id, pool);
  if (!quoted) throw new SkipTask('Original message vanished');

  const from = partyFor(me);
  const to = partyFor(recipient);
  const tag = orgTagIfEnabled(me.org.id);
  const rendered = renderTurn(forwardNote(language, rng), language, from.persona, to.persona, rng, { includeHtml: true, tag });
  const block = forwardBlock(from.style, quoted.original);
  const subject = forwardSubject(sourceThread.subject, from.style);
  const threadId = nanoid();
  const now = Date.now();
  const turnsPlanned = rng.chance(40) ? 2 : 1;
  db.insert(schema.warmupThreads)
    .values({
      id: threadId,
      kind: 'forward',
      initiatorAccountId: me.account.id,
      participantsJson: JSON.stringify([me.account.id, recipient.account.id]),
      subject,
      scriptId: null,
      language,
      turnsPlanned,
      turnsDone: 0,
      state: 'active',
      internal: recipient.domain === me.domain ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const id = newWarmupMessageId(me.account.email, me.account.provider);
  const message = registerMessage({
    threadId,
    turn: 0,
    kind: 'forward',
    fromAccountId: me.account.id,
    toAccountId: recipient.account.id,
    rfcMessageId: id.normalized,
    subject,
    contentSource: 'ack',
    localDate: todayFor(me),
  });
  db.update(schema.warmupMessages).set({ bodyText: `${rendered.text}\n${block.text}` }).where(eq(schema.warmupMessages.id, message.id)).run();
  const raw = await buildWarmupMime({
    from,
    to: [to],
    subject,
    text: `${rendered.text}\n${block.text}`,
    html: rendered.html ? `${rendered.html}<br>${block.html}` : null,
    messageIdHeader: id.header,
    normalizedMessageId: id.normalized,
  });
  await queueWarmupSend(me, raw, [recipient.account.email], subject, message.id);
  db.update(schema.warmupThreads).set({ turnsDone: 1, updatedAt: Date.now() }).where(eq(schema.warmupThreads.id, threadId)).run();
  const landing = landingById(payload.landingId);
  if (landing) updateLanding(landing.id, { forwardedAt: Date.now() });
  logActivity({
    category: 'warmup',
    action: 'send-forward',
    status: 'ok',
    accountId: me.account.id,
    detail: `"${subject}" → ${recipient.account.email}`,
  });
}

// --- send_mdn -------------------------------------------------------------------

async function handleSendMdn(task: WarmupTask, payload: { landingId: string; messageId: string }): Promise<void> {
  const pool = loadPool();
  const me = memberById(pool, task.accountId);
  if (!me) throw new SkipTask('Recipient is no longer in the pool');
  const original = messageById(payload.messageId);
  if (!original || !original.requestedReceipt) throw new SkipTask('No receipt was requested');
  const sender = memberById(pool, original.fromAccountId);
  if (!sender || sender.account.status !== 'active') throw new SkipTask('Original sender is unavailable');
  const id = newWarmupMessageId(me.account.email, me.account.provider);
  const message = registerMessage({
    threadId: original.threadId,
    turn: 99,
    kind: 'mdn',
    fromAccountId: me.account.id,
    toAccountId: sender.account.id,
    rfcMessageId: id.normalized,
    inReplyToMessageId: original.rfcMessageId,
    subject: `Read: ${original.subject}`,
    contentSource: 'system',
    localDate: todayFor(me),
  });
  const raw = buildMdnMime({
    from: partyFor(me),
    to: partyFor(sender),
    originalMessageIdHeader: `<${original.rfcMessageId}>`,
    originalSubject: original.subject,
    messageIdHeader: id.header,
    normalizedMessageId: id.normalized,
    displayedAt: Date.now(),
  });
  await queueWarmupSend(me, raw, [sender.account.email], `Read: ${original.subject}`, message.id);
  const landing = landingById(payload.landingId);
  if (landing) updateLanding(landing.id, { receiptSentAt: Date.now() });
  logActivity({
    category: 'warmup',
    action: 'send-receipt',
    status: 'ok',
    accountId: me.account.id,
    detail: `read receipt for "${original.subject}" → ${sender.account.email}`,
  });
}

// --- engagement ---------------------------------------------------------------

async function handleEngagement(task: WarmupTask, payload: { landingId: string }): Promise<void> {
  const landing = landingById(payload.landingId);
  if (!landing) throw new SkipTask('Landing row vanished');
  if (!landing.providerMessageId) throw new SkipTask('No provider message id for this landing yet');
  const pool = loadPool();
  const me = memberById(pool, task.accountId);
  if (!me) throw new SkipTask('Mailbox is no longer in the pool');
  if (!me.canWrite) throw new SkipTask('Mailbox lacks write scope; reconnect to enable engagement');
  const provider = providerFor(me.account.provider);
  const pmid = landing.providerMessageId;
  const message = messageById(landing.messageId);
  const now = Date.now();
  const detail = message ? `"${message.subject}" from ${memberById(pool, message.fromAccountId)?.account.email ?? message.fromAccountId}` : landing.messageId;

  try {
    switch (task.kind) {
      case 'mark_read':
        await provider.setMessageFlags(me.account.id, pmid, { seen: true });
        updateLanding(landing.id, { readAt: now });
        break;
      case 'star':
        await provider.setMessageFlags(me.account.id, pmid, { flagged: true });
        updateLanding(landing.id, { starredAt: now });
        break;
      case 'mark_important':
        await provider.setImportant(me.account.id, pmid, true);
        updateLanding(landing.id, { importantAt: now });
        break;
      case 'fix_category':
        await provider.fixCategory(me.account.id, pmid);
        updateLanding(landing.id, { categoryFixedAt: now });
        break;
      case 'rescue': {
        const newId = await provider.moveMessage(me.account.id, pmid, 'Spam', 'INBOX');
        updateLanding(landing.id, { rescuedAt: now, providerMessageId: newId ?? pmid });
        const refreshed = landingById(landing.id)!;
        if (message) {
          const sender = memberById(pool, message.fromAccountId);
          if (sender) emitWarmupEvent(sender.account, 'warmup.rescued', { subject: message.subject, recipient: me.account.email });
          scheduleEngagement(refreshed, message, me, now);
        }
        break;
      }
      case 'cleanup': {
        let newId: string | null = null;
        if (me.settings.cleanupMode === 'archive') newId = await provider.archiveMessage(me.account.id, pmid);
        else if (me.settings.cleanupMode === 'label') newId = await provider.moveToNamedFolder(me.account.id, pmid, 'Warmup');
        else if (me.settings.cleanupMode === 'trash') newId = await provider.trashMessage(me.account.id, pmid);
        updateLanding(landing.id, { cleanedAt: now, providerMessageId: newId ?? pmid });
        break;
      }
      default:
        throw new SkipTask(`Unknown engagement kind ${task.kind}`);
    }
  } catch (err) {
    if (isMessageGone(err)) {
      // The owner deleted or moved it; nothing left to do with it.
      updateLanding(landing.id, { cleanedAt: landing.cleanedAt ?? now });
      throw new SkipTask('Message is gone from the mailbox');
    }
    throw err;
  }
  logActivity({
    category: 'warmup',
    action: task.kind.replace('_', '-'),
    status: 'ok',
    accountId: me.account.id,
    detail,
  });
}

// --- loop -----------------------------------------------------------------------

export async function runTask(task: WarmupTask): Promise<void> {
  const payload = JSON.parse(task.payloadJson) as never;
  switch (task.kind) {
    case 'send_open':
      return handleSendOpen(task, payload);
    case 'send_reply':
      return handleSendReply(task, payload);
    case 'send_forward':
      return handleSendForward(task, payload);
    case 'send_mdn':
      return handleSendMdn(task, payload);
    default:
      return handleEngagement(task, payload);
  }
}

async function processTask(task: WarmupTask): Promise<void> {
  try {
    await runTask(task);
    completeTask(task.id);
  } catch (err) {
    if (err instanceof SkipTask) {
      skipTask(task.id, err.message);
      logger.debug({ task: task.kind, account: task.accountId, reason: err.message }, 'warmup task skipped');
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const status = failTask(task, message);
    logActivity({
      category: 'warmup',
      action: task.kind.replace('_', '-'),
      status: 'failed',
      accountId: task.accountId,
      detail: status === 'failed' ? 'gave up' : `retry ${task.attempts + 1}/${task.maxAttempts}`,
      error: message,
    });
    if (err instanceof AuthError) {
      logger.warn({ account: task.accountId }, 'warmup task hit an auth error; account will be blocked upstream');
    }
  }
}

let running = false;
let stopped = false;

export async function executorTick(): Promise<void> {
  if (running || stopped) return;
  running = true;
  try {
    skipStaleSendTasks();
    for (let round = 0; round < 5; round++) {
      const tasks = claimTasks(workerId, 10);
      if (tasks.length === 0) break;
      await Promise.allSettled(tasks.map(processTask));
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'warmup executor tick failed');
  } finally {
    running = false;
  }
}

export function startWarmupExecutor(): () => void {
  reapStuckTasks(0);
  const interval = setInterval(() => void executorTick(), 20_000);
  interval.unref();
  const reaper = setInterval(() => reapStuckTasks(), 60_000);
  reaper.unref();
  logger.info({ workerId, grace: config.WARMUP_TASK_GRACE_MINUTES }, 'warmup executor started');
  return () => {
    stopped = true;
    clearInterval(interval);
    clearInterval(reaper);
  };
}

