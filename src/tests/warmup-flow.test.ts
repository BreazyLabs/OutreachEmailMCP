/**
 * End-to-end through the engine with a fake provider: plan → open a
 * conversation → the partner receives it (poller hook) → engagement is
 * scheduled → reply goes out threaded → a spam landing is found by the
 * sweep and rescued. Along the way every read surface must hide the mail.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';

process.env.MASTER_KEY = Buffer.alloc(32, 11).toString('base64');
process.env.DATA_DIR = './data-test/warmup-flow';
process.env.BASE_URL = 'http://localhost:3000';
process.env.SAAS_MODE = 'false'; // the local .env may set it
process.env.WARMUP_MIN_POOL_SIZE = '2';

vi.mock('../auth/tokens.js', () => ({
  getAccessToken: async () => 'fake-token',
  saveTokens: () => {},
  hasRefreshToken: () => true,
  markAuthError: () => {},
  startTokenRefreshSweep: () => setTimeout(() => {}, 0),
}));

// In-memory "mailboxes": provider message id → { folder, labels }
const upstream = {
  moves: [] as { accountId: string; id: string; from: string; to: string }[],
  flags: [] as { accountId: string; id: string; flags: Record<string, boolean> }[],
  important: [] as string[],
  spamIds: {} as Record<string, string[]>,
  raws: {} as Record<string, Buffer>,
  placement: {} as Record<string, { category: string | null; important: boolean; inSpam: boolean }>,
};

vi.mock('../providers/index.js', () => {
  const provider = {
    maxRawSize: 25 * 1024 * 1024,
    supportsWrite: () => true,
    sendRaw: async () => 'prov-sent',
    listFolders: async () => [],
    listMessages: async () => ({ messages: [], nextPageToken: null }),
    getMessageRaw: async (_a: string, id: string) => {
      const raw = upstream.raws[id];
      if (!raw) throw new Error('no raw');
      return raw;
    },
    initCursor: async () => 'c',
    pollChanges: async () => ({ newMessageIds: [], nextCursor: 'c' }),
    listMessageIds: async (accountId: string, folder: string) =>
      folder === 'Spam' ? upstream.spamIds[accountId] ?? [] : [],
    moveMessage: async (accountId: string, id: string, from: string, to: string) => {
      upstream.moves.push({ accountId, id, from, to });
      return null;
    },
    setMessageFlags: async (accountId: string, id: string, flags: Record<string, boolean>) => {
      upstream.flags.push({ accountId, id, flags });
    },
    getMessagePlacement: async (_a: string, id: string) =>
      upstream.placement[id] ?? { category: 'primary', important: false, inSpam: false },
    setImportant: async (_a: string, id: string) => {
      upstream.important.push(id);
    },
    fixCategory: async () => {},
    archiveMessage: async () => null,
    moveToNamedFolder: async () => null,
    trashMessage: async () => null,
  };
  return { providerFor: () => provider };
});

const A = 'acct-alice';
const B = 'acct-bob';
const C = 'acct-carol';
let orgId: string;

async function seed() {
  const { runMigrations, db, schema } = await import('../db/index.js');
  runMigrations();
  const { createOrgWithOwner } = await import('../tenancy/orgs.js');
  orgId = createOrgWithOwner({ orgName: 'Flow', email: 'flow@f.test', password: 'password-abc' }).orgId;
  const now = Date.now();
  for (const [id, email, provider, name] of [
    [A, 'alice@alpha.test', 'google', 'Alice Alpha'],
    [B, 'bob@beta.test', 'microsoft', 'Bob Beta'],
    [C, 'carol@alpha.test', 'google', 'Carol Alpha'],
  ] as const) {
    db.insert(schema.accounts)
      .values({ id, orgId, provider, email, displayName: name, status: 'active', createdAt: now, updatedAt: now })
      .run();
    db.insert(schema.oauthTokens)
      .values({ accountId: id, accessTokenEnc: 'x', refreshTokenEnc: 'y', expiresAt: now + 1e9, scopes: 'gmail.modify Mail.ReadWrite', updatedAt: now })
      .run();
    db.insert(schema.syncState).values({ accountId: id, cursor: 'c', lastPolledAt: now }).run();
  }
}

describe('warmup end to end', () => {
  beforeAll(async () => {
    await seed();
    const { seedTemplateScripts } = await import('../warmup/content/scripts.js');
    seedTemplateScripts();
    const { enableWarmup } = await import('../warmup/state.js');
    enableWarmup(A);
    enableWarmup(B);
    enableWarmup(C);
  });

  it('plans a day deterministically and idempotently, pairing across the pool', async () => {
    const { planAll } = await import('../warmup/planner.js');
    const { db, schema } = await import('../db/index.js');
    const { localToInstant, localDate } = await import('../warmup/clock.js');
    const today = localDate(Date.now(), 'UTC');
    const nineAm = localToInstant(today, 9 * 60, 'UTC');
    const first = planAll(nineAm);
    expect(first.length).toBe(3);
    for (const o of first) {
      expect(o.target).toBeGreaterThan(0);
      expect(o.planned).toBeGreaterThan(0);
    }
    const tasksAfterFirst = db.select().from(schema.warmupTasks).all();
    const second = planAll(nineAm + 60_000);
    expect(second).toEqual([]);
    expect(db.select().from(schema.warmupTasks).all().length).toBe(tasksAfterFirst.length);
    for (const t of tasksAfterFirst) {
      expect(t.kind).toBe('send_open');
      expect(t.counterpartyAccountId).not.toBe(t.accountId);
      expect(t.dueAt).toBeGreaterThan(nineAm);
    }
  });

  it('opens a conversation, hides it everywhere, and the partner engages and replies in-thread', async () => {
    const { db, schema } = await import('../db/index.js');
    const { eq, and } = await import('drizzle-orm');
    const { enqueueTask, pendingTasksFor } = await import('../warmup/tasks.js');
    const { runTask } = await import('../warmup/executor.js');
    const { onWarmupJobSent } = await import('../warmup/ledger.js');
    const { onInboundMessage } = await import('../warmup/detector.js');
    const { indexMessage, messagesFor } = await import('../imap/index-store.js');
    const { filterSummaries, isWarmupMessage } = await import('../warmup/identity.js');
    const { countSendsLast24h } = await import('../tenancy/orgs.js');
    const { simpleParser } = await import('mailparser');
    const { localDate } = await import('../warmup/clock.js');

    // Give Alice a target so the cap check passes; make Bob's engagement
    // lotteries certain so the assertions below are deterministic.
    db.update(schema.warmupAccounts).set({ todayTarget: 10 }).where(eq(schema.warmupAccounts.accountId, A)).run();
    db.update(schema.warmupAccounts)
      .set({ settingsJson: JSON.stringify({ readRate: 100, readReceiptSendRate: 100, replyRate: 100, starRate: 100 }) })
      .where(eq(schema.warmupAccounts.accountId, B))
      .run();
    const task = enqueueTask({
      accountId: A,
      counterpartyAccountId: B,
      kind: 'send_open',
      dueAt: Date.now(),
      idempotencyKey: 'open:test:1',
      payload: { partnerAccountId: B, ccAccountId: null, internal: false, requestReceipt: true, date: localDate(Date.now(), 'UTC'), seq: 0 },
    })!;
    await runTask(task);

    const job = db.select().from(schema.sendJobs).where(eq(schema.sendJobs.accountId, A)).get()!;
    expect(job.source).toBe('warmup');
    expect(job.warmupMessageId).toBeTruthy();
    const message = db.select().from(schema.warmupMessages).where(eq(schema.warmupMessages.id, job.warmupMessageId!)).get()!;
    expect(message.kind).toBe('open');
    expect(message.requestedReceipt).toBe(1);
    const thread = db.select().from(schema.warmupThreads).where(eq(schema.warmupThreads.id, message.threadId)).get()!;
    expect(thread.turnsDone).toBe(1);
    expect(JSON.parse(thread.participantsJson)).toEqual([A, B]);

    // Real send quota does not count it; stats exclude it via source.
    expect(countSendsLast24h(orgId)).toBe(0);

    // The worker reports it sent.
    onWarmupJobSent({ ...job });
    expect(db.select().from(schema.warmupMessages).where(eq(schema.warmupMessages.id, message.id)).get()!.sentAt).toBeTruthy();

    // It arrives in Bob's INBOX: the poller hook sees it.
    const raw = fs.readFileSync(job.rawPath!);
    const parsed = await simpleParser(raw);
    expect(parsed.messageId).toBe(`<${message.rfcMessageId}>`);
    const bob = db.select().from(schema.accounts).where(eq(schema.accounts.id, B)).get()!;
    upstream.raws['bob-msg-1'] = raw;
    const verdict = await onInboundMessage(bob, 'bob-msg-1', parsed, raw);
    expect(verdict).toEqual({ warmup: true, humanOnWarmupThread: false });

    const landing = db
      .select()
      .from(schema.warmupLandings)
      .where(and(eq(schema.warmupLandings.messageId, message.id), eq(schema.warmupLandings.toAccountId, B)))
      .get()!;
    expect(landing.landed).toBe('inbox');
    expect(landing.providerMessageId).toBe('bob-msg-1');

    // Hidden from IMAP, listings, and flagged on fetch.
    indexMessage(B, 'bob-msg-1', raw, parsed, 'INBOX', null, verdict.warmup);
    expect(messagesFor(B, 'INBOX')).toEqual([]);
    const row = db.select().from(schema.imapMessages).where(eq(schema.imapMessages.providerMessageId, 'bob-msg-1')).get()!;
    expect(row.warmup).toBe(1);
    expect(filterSummaries([{ id: 'bob-msg-1', from: null, to: null, subject: parsed.subject ?? null, date: null, snippet: null, unread: true, hasAttachments: false, messageId: parsed.messageId ?? null }])).toEqual([]);
    // Index without an explicit flag decides for itself.
    upstream.raws['bob-msg-1b'] = raw;
    indexMessage(B, 'bob-msg-1b', raw, parsed, 'Spam');
    expect(db.select().from(schema.imapMessages).where(eq(schema.imapMessages.providerMessageId, 'bob-msg-1b')).get()!.warmup).toBe(1);
    expect(isWarmupMessage({ messageId: parsed.messageId }).via).toBe('registry');

    // Engagement was scheduled for Bob (read at least; the rest by lottery).
    const bobTasks = pendingTasksFor(B).filter((t) => t.kind !== 'send_open');
    const kinds = bobTasks.map((t) => t.kind);
    expect(kinds).toContain('mark_read');
    expect(kinds).toContain('star');
    expect(kinds).toContain('send_mdn');
    expect(kinds).toContain('cleanup');
    for (const t of bobTasks) expect(t.dueAt).toBeGreaterThan(Date.now() - 1000);

    // Run whatever engagement exists now, then force a reply and a receipt.
    for (const t of bobTasks.filter((x) => x.kind === 'mark_read' || x.kind === 'star' || x.kind === 'mark_important')) {
      await runTask(t);
    }
    expect(upstream.flags.some((f) => f.accountId === B && f.id === 'bob-msg-1' && f.flags.seen)).toBe(true);
    const after = db.select().from(schema.warmupLandings).where(eq(schema.warmupLandings.id, landing.id)).get()!;
    expect(after.readAt).toBeTruthy();

    db.update(schema.warmupAccounts).set({ todayTarget: 10 }).where(eq(schema.warmupAccounts.accountId, B)).run();
    const mdnTask = enqueueTask({ accountId: B, counterpartyAccountId: A, kind: 'send_mdn', dueAt: Date.now(), idempotencyKey: 'mdn:test', payload: { landingId: landing.id, messageId: message.id } })!;
    await runTask(mdnTask);
    const mdnJob = db.select().from(schema.sendJobs).where(and(eq(schema.sendJobs.accountId, B), eq(schema.sendJobs.source, 'warmup'))).all().find((j) => j.subject?.startsWith('Read:'))!;
    expect(mdnJob).toBeTruthy();
    expect(fs.readFileSync(mdnJob.rawPath!).toString()).toContain('disposition-notification');

    // Force the thread to allow a reply and run it.
    db.update(schema.warmupThreads).set({ turnsPlanned: 3 }).where(eq(schema.warmupThreads.id, thread.id)).run();
    const replyTask = enqueueTask({ accountId: B, counterpartyAccountId: A, kind: 'send_reply', dueAt: Date.now(), idempotencyKey: 'reply:test', payload: { landingId: landing.id, messageId: message.id, threadId: thread.id } })!;
    await runTask(replyTask);
    const replyMessage = db.select().from(schema.warmupMessages).where(and(eq(schema.warmupMessages.threadId, thread.id), eq(schema.warmupMessages.kind, 'reply'))).get()!;
    expect(replyMessage.fromAccountId).toBe(B);
    expect(replyMessage.inReplyToMessageId).toBe(message.rfcMessageId);
    const replyJob = db.select().from(schema.sendJobs).where(eq(schema.sendJobs.warmupMessageId, replyMessage.id)).get()!;
    const replyParsed = await simpleParser(fs.readFileSync(replyJob.rawPath!));
    expect(replyParsed.inReplyTo).toBe(`<${message.rfcMessageId}>`);
    expect(replyParsed.references).toContain(message.rfcMessageId);
    expect(replyParsed.subject).toMatch(/^Re: /);
    // Outlook-style quoting for a Microsoft sender, quoting Alice's text
    expect(replyParsed.text).toContain('From: Alice Alpha <alice@alpha.test>');
    expect(replyParsed.text).toContain(message.bodyText!.split('\n')[0]!);
    expect(db.select().from(schema.warmupThreads).where(eq(schema.warmupThreads.id, thread.id)).get()!.turnsDone).toBe(2);
    expect(db.select().from(schema.warmupLandings).where(eq(schema.warmupLandings.id, landing.id)).get()!.repliedAt).toBeTruthy();

    // A person replying on the thread closes it and stays visible.
    const humanRaw = Buffer.from(
      [
        'From: Bob Beta <bob@beta.test>',
        'To: alice@alpha.test',
        `Subject: Re: ${message.subject}`,
        'Message-ID: <human-1@beta.test>',
        `In-Reply-To: <${message.rfcMessageId}>`,
        'Content-Type: text/plain',
        '',
        'Actually, who is this?',
      ].join('\r\n'),
    );
    const alice = db.select().from(schema.accounts).where(eq(schema.accounts.id, A)).get()!;
    const hv = await onInboundMessage(alice, 'alice-human-1', await simpleParser(humanRaw), humanRaw);
    expect(hv).toEqual({ warmup: false, humanOnWarmupThread: true });
    expect(db.select().from(schema.warmupThreads).where(eq(schema.warmupThreads.id, thread.id)).get()!.state).toBe('abandoned');
  });

  it('forwards a received message to a third mailbox as a new thread', async () => {
    const { db, schema } = await import('../db/index.js');
    const { eq, and } = await import('drizzle-orm');
    const { enqueueTask } = await import('../warmup/tasks.js');
    const { runTask } = await import('../warmup/executor.js');
    const { simpleParser } = await import('mailparser');
    const original = db.select().from(schema.warmupMessages).where(eq(schema.warmupMessages.kind, 'open')).get()!;
    const landing = db.select().from(schema.warmupLandings).where(and(eq(schema.warmupLandings.messageId, original.id), eq(schema.warmupLandings.toAccountId, B))).get()!;
    const t = enqueueTask({ accountId: B, counterpartyAccountId: A, kind: 'send_forward', dueAt: Date.now(), idempotencyKey: 'fwd:test', payload: { landingId: landing.id, messageId: original.id, threadId: original.threadId } })!;
    await runTask(t);
    const fwd = db.select().from(schema.warmupMessages).where(eq(schema.warmupMessages.kind, 'forward')).get()!;
    expect(fwd.fromAccountId).toBe(B);
    expect(fwd.toAccountId).toBe(C); // the only third mailbox
    const thread = db.select().from(schema.warmupThreads).where(eq(schema.warmupThreads.id, fwd.threadId)).get()!;
    expect(thread.kind).toBe('forward');
    const job = db.select().from(schema.sendJobs).where(eq(schema.sendJobs.warmupMessageId, fwd.id)).get()!;
    const parsed = await simpleParser(fs.readFileSync(job.rawPath!));
    expect(parsed.subject).toMatch(/^FW: /);
    expect(parsed.text).toContain('From: Alice Alpha <alice@alpha.test>');
    expect(db.select().from(schema.warmupLandings).where(eq(schema.warmupLandings.id, landing.id)).get()!.forwardedAt).toBeTruthy();
  });

  it('finds a message in Spam, records it against the sender, rescues it, then engages', async () => {
    const { db, schema } = await import('../db/index.js');
    const { eq, and } = await import('drizzle-orm');
    const { enqueueTask, pendingTasksFor } = await import('../warmup/tasks.js');
    const { runTask } = await import('../warmup/executor.js');
    const { onWarmupJobSent } = await import('../warmup/ledger.js');
    const { sweepSpam } = await import('../warmup/detector.js');
    const { loadPool, memberById, senderPlacement } = await import('../warmup/pool.js');
    const { localDate } = await import('../warmup/clock.js');

    // Carol opens a conversation with Alice; it lands in Alice's Spam.
    db.update(schema.warmupAccounts).set({ todayTarget: 10, settingsJson: JSON.stringify({ rescueDelayMinMinutes: 0, rescueDelayMaxMinutes: 1 }) }).where(eq(schema.warmupAccounts.accountId, C)).run();
    db.update(schema.warmupAccounts).set({ settingsJson: JSON.stringify({ rescueDelayMinMinutes: 0, rescueDelayMaxMinutes: 1, readRate: 100 }) }).where(eq(schema.warmupAccounts.accountId, A)).run();
    const task = enqueueTask({ accountId: C, counterpartyAccountId: A, kind: 'send_open', dueAt: Date.now(), idempotencyKey: 'open:test:spam', payload: { partnerAccountId: A, ccAccountId: null, internal: true, requestReceipt: false, date: localDate(Date.now(), 'UTC'), seq: 9 } })!;
    await runTask(task);
    const job = db.select().from(schema.sendJobs).where(eq(schema.sendJobs.accountId, C)).get()!;
    onWarmupJobSent(job);
    const message = db.select().from(schema.warmupMessages).where(eq(schema.warmupMessages.id, job.warmupMessageId!)).get()!;
    const thread = db.select().from(schema.warmupThreads).where(eq(schema.warmupThreads.id, message.threadId)).get()!;
    expect(thread.internal).toBe(1); // same domain

    upstream.raws['alice-spam-1'] = fs.readFileSync(job.rawPath!);
    upstream.spamIds[A] = ['alice-spam-1', 'unrelated-spam'];
    upstream.raws['unrelated-spam'] = Buffer.from('From: x@y.z\r\nTo: alice@alpha.test\r\nSubject: buy now\r\nMessage-ID: <junk@y.z>\r\n\r\nspam');
    const pool = loadPool();
    const alice = memberById(pool, A)!;
    const found = await sweepSpam(alice, pool);
    expect(found).toBe(1);
    const landing = db.select().from(schema.warmupLandings).where(and(eq(schema.warmupLandings.messageId, message.id), eq(schema.warmupLandings.toAccountId, A))).get()!;
    expect(landing.landed).toBe('spam');
    expect(senderPlacement(C, 7).spam).toBe(1);
    // Second sweep does not re-fetch or double count
    expect(await sweepSpam(memberById(loadPool(), A)!, pool)).toBe(0);

    const rescue = pendingTasksFor(A).find((t) => t.kind === 'rescue')!;
    expect(rescue).toBeTruthy();
    await runTask(rescue);
    expect(upstream.moves).toContainEqual({ accountId: A, id: 'alice-spam-1', from: 'Spam', to: 'INBOX' });
    const rescued = db.select().from(schema.warmupLandings).where(eq(schema.warmupLandings.id, landing.id)).get()!;
    expect(rescued.rescuedAt).toBeTruthy();
    expect(rescued.landed).toBe('spam'); // the verdict stays; rescue is a separate fact
    // Engagement follows the rescue
    expect(pendingTasksFor(A).map((t) => t.kind)).toContain('mark_read');
  });

  it('marks sent mail that never arrived as missing', async () => {
    const { db, schema } = await import('../db/index.js');
    const { eq } = await import('drizzle-orm');
    const { markMissing, registerMessage, onWarmupJobSent } = await import('../warmup/ledger.js');
    const { newWarmupMessageId } = await import('../warmup/identity.js');
    const id = newWarmupMessageId('alice@alpha.test');
    const m = registerMessage({ threadId: 'tm', turn: 0, kind: 'open', fromAccountId: A, toAccountId: B, rfcMessageId: id.normalized, subject: 'Lost', contentSource: 'template', localDate: '2026-09-01' });
    onWarmupJobSent({ warmupMessageId: m.id } as never);
    expect(markMissing(Date.now())).toBe(0);
    expect(markMissing(Date.now() + 7 * 3600_000)).toBe(1);
    expect(db.select().from(schema.warmupLandings).where(eq(schema.warmupLandings.messageId, m.id)).get()!.landed).toBe('missing');
  });

  it('exposes the read models the UI and API use', async () => {
    const { getOrg } = await import('../tenancy/orgs.js');
    const { orgWarmupOverview, accountWarmupDetail, recentWarmupMessages } = await import('../warmup/stats.js');
    const { db, schema } = await import('../db/index.js');
    const { eq } = await import('drizzle-orm');
    const org = getOrg(orgId)!;
    const overview = orgWarmupOverview(org);
    expect(overview.accounts.length).toBe(3);
    expect(overview.totals.enabled).toBe(3);
    expect(overview.pool.reachable).toBe(3);
    expect(overview.org.filterTag).toMatch(/^[A-Z0-9]{7}$/);
    const alice = db.select().from(schema.accounts).where(eq(schema.accounts.id, A)).get()!;
    const detail = accountWarmupDetail(alice, org);
    expect(detail.persona.firstName).toBe('Alice');
    expect(detail.settings.settings.dailyLimit).toBe(30);
    expect(detail.messages.length).toBeGreaterThan(0);
    const rows = recentWarmupMessages(B, 50);
    expect(rows.some((r) => r.direction === 'received' && r.landed === 'inbox')).toBe(true);
    expect(rows.some((r) => r.direction === 'sent' && r.kind === 'reply')).toBe(true);
  });

  it('bulk-applies settings and actions through the API layer', async () => {
    const { runBulk, applyOrgSettings } = await import('../warmup/api.js');
    const { resolveForAccount } = await import('../warmup/settings.js');
    const { getWarmupAccount } = await import('../warmup/state.js');
    const r = runBulk(orgId, { accountIds: [A, B, 'not-mine'], settings: { dailyLimit: 12, replyRate: 5 } });
    expect(r.results.filter((x) => x.ok).length).toBe(2);
    expect(resolveForAccount(A).settings.dailyLimit).toBe(12);
    expect(resolveForAccount(A).sources.dailyLimit).toBe('account');
    runBulk(orgId, { accountIds: [A], action: 'pause' });
    expect(getWarmupAccount(A)!.state).toBe('paused');
    runBulk(orgId, { accountIds: [A], action: 'resume' });
    expect(getWarmupAccount(A)!.state).toBe('ramping');
    runBulk(orgId, { accountIds: [A, B], action: 'clear_overrides' });
    expect(resolveForAccount(A).sources.dailyLimit).toBe('instance');
    applyOrgSettings(orgId, { defaults: { dailyLimit: 20 }, poolScope: 'org', emitWebhooks: true });
    expect(resolveForAccount(B).settings.dailyLimit).toBe(20);
    expect(resolveForAccount(B).sources.dailyLimit).toBe('org');
    expect(() => runBulk(orgId, { accountIds: [A], settings: { nope: 1 } })).toThrow();
  });
});
