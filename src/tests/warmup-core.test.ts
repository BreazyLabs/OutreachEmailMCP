import { describe, it, expect, beforeAll } from 'vitest';

process.env.MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.DATA_DIR = './data-test/warmup-core';
process.env.BASE_URL = 'http://localhost:3000';
process.env.SAAS_MODE = 'false'; // the local .env may set it

describe('warmup settings', () => {
  it('layers instance → org → account and reports the source of each value', async () => {
    const { resolveWarmupSettings, INSTANCE_DEFAULTS } = await import('../warmup/settings.js');
    const r = resolveWarmupSettings(
      { plan: 'pro', warmupDefaultsJson: JSON.stringify({ dailyLimit: 40, replyRate: 20 }) },
      { settingsJson: JSON.stringify({ replyRate: 50, timezone: 'Europe/Amsterdam' }) },
    );
    expect(r.settings.dailyLimit).toBe(40);
    expect(r.sources.dailyLimit).toBe('org');
    expect(r.settings.replyRate).toBe(50);
    expect(r.sources.replyRate).toBe('account');
    expect(r.settings.timezone).toBe('Europe/Amsterdam');
    expect(r.settings.startVolume).toBe(INSTANCE_DEFAULTS.startVolume);
    expect(r.sources.startVolume).toBe('instance');
  });

  it('caps dailyLimit at the instance ceiling and drops invalid stored values', async () => {
    const { resolveWarmupSettings } = await import('../warmup/settings.js');
    const r = resolveWarmupSettings(
      { plan: 'pro', warmupDefaultsJson: JSON.stringify({ dailyLimit: 400, timezone: 'Mars/Olympus' }) },
      null,
    );
    expect(r.settings.dailyLimit).toBe(50);
    expect(r.sources.dailyLimit).toBe('cap');
    expect(r.settings.timezone).toBe('UTC');
  });

  it('parses form submissions: blank = unchanged, __inherit = clear, lists split', async () => {
    const { patchFromForm, mergePatch, parsePatch } = await import('../warmup/settings.js');
    const patch = patchFromForm({
      dailyLimit: '25',
      replyRate: '',
      weekdaysOnly: 'true',
      languages: 'en, NL',
      starRate: '__inherit',
    });
    expect(patch).toEqual({ dailyLimit: 25, weekdaysOnly: true, languages: ['en', 'nl'], starRate: null });
    const merged = mergePatch(JSON.stringify({ starRate: 30, replyRate: 10 }), patch);
    expect(parsePatch(merged)).toEqual({ replyRate: 10, dailyLimit: 25, weekdaysOnly: true, languages: ['en', 'nl'] });
  });

  it('rejects unknown keys and out-of-range values from the API', async () => {
    const { validatePatch } = await import('../warmup/settings.js');
    expect(() => validatePatch({ bogus: 1 })).toThrow();
    expect(() => validatePatch({ replyRate: 150 })).toThrow();
    expect(() => validatePatch({ replyDelayMinMinutes: 500, replyDelayMaxMinutes: 10 })).toThrow();
  });
});

describe('warmup health and prefilled forms', () => {
  const base = {
    accountId: 'a', email: 'a@x.test', provider: 'google', accountStatus: 'active', enabled: true,
    state: 'steady' as const, rampDay: 9, startedAt: Date.now() - 10 * 86_400_000, todayTarget: 20, todaySent: 12,
    todayReceived: 10, receiveLimit: 45, dailyLimit: 30,
    placement7d: { inbox: 90, spam: 0, category: 0, missing: 0, bounced: 0, pending: 3, total: 93 },
    inboxRate7d: 100, spamRate7d: 0, rescued7d: 0, repliesSent7d: 20, forwards7d: 2, receipts7d: 1,
    throttlePercent: 100, pauseReason: null, pausedUntil: null, canWrite: true, pendingTasks: 4, lastEvent: null, timezone: 'UTC',
    dns: { verdict: 'ok' as const, issues: [], checkedAt: Date.now(), spf: true, dkim: true, dmarc: true, dmarcPolicy: 'quarantine' },
  };
  it('scores placement, interventions and scope, and rolls up by weight', async () => {
    const { healthOf, orgHealth } = await import('../warmup/health.js');
    expect(healthOf(base)).toMatchObject({ score: 100, label: 'healthy' });
    const spammy = { ...base, placement7d: { ...base.placement7d, inbox: 80, spam: 10 } };
    const h = healthOf(spammy);
    expect(h.label).toBe('watch');
    expect(h.score).toBe(67);
    expect(h.reasons[0]).toContain('11% of sent warmup mail landed in spam');
    expect(healthOf({ ...base, state: 'auto_paused' }).label).toBe('watch');
    expect(healthOf({ ...base, state: 'auto_paused', canWrite: false, placement7d: { ...base.placement7d, bounced: 2 } }).label).toBe('at_risk');
    expect(healthOf({ ...base, enabled: false, state: 'off' }).label).toBe('off');
    expect(healthOf({ ...base, placement7d: { inbox: 2, spam: 0, category: 0, missing: 0, bounced: 0, pending: 1, total: 3 } }).label).toBe('no_data');
    const stalled = { ...base, todaySent: 0, placement7d: { inbox: 0, spam: 0, category: 0, missing: 0, bounced: 0, pending: 0, total: 0 } };
    expect(healthOf(stalled).label).toBe('at_risk');
    const noDns = healthOf({ ...base, dns: { ...base.dns, spf: false, dkim: false, dmarc: false } });
    expect(noDns.score).toBe(60);
    expect(noDns.reasons.some((r) => r.includes('SPF'))).toBe(true);
    const org = orgHealth([base, spammy, { ...base, enabled: false, state: 'off' as const }]);
    expect(org.counts).toMatchObject({ healthy: 1, watch: 1, off: 1 });
    expect(org.score).toBe(84); // weighted toward the two with data
  });

  it('keeps only real changes from a pre-filled form', async () => {
    const { diffAgainstBaseline, INSTANCE_DEFAULTS, patchFromForm } = await import('../warmup/settings.js');
    const patch = patchFromForm({ dailyLimit: '30', replyRate: '50', languages: 'en', weekdaysOnly: 'false' });
    const diff = diffAgainstBaseline(patch, INSTANCE_DEFAULTS);
    expect(diff).toEqual({ dailyLimit: null, replyRate: 50, languages: null, weekdaysOnly: null });
  });
});

describe('warmup clock', () => {
  it('converts local wall-clock time to instants across a DST zone', async () => {
    const { localToInstant, localDate, localMinutes } = await import('../warmup/clock.js');
    const tz = 'Europe/Amsterdam';
    const at = localToInstant('2026-07-15', 9 * 60 + 30, tz);
    expect(localDate(at, tz)).toBe('2026-07-15');
    expect(localMinutes(at, tz)).toBe(9 * 60 + 30);
    // CEST is UTC+2 in July
    expect(new Date(at).toISOString()).toBe('2026-07-15T07:30:00.000Z');
    const winter = localToInstant('2026-01-15', 9 * 60 + 30, tz);
    expect(new Date(winter).toISOString()).toBe('2026-01-15T08:30:00.000Z');
  });
});

describe('warmup rng', () => {
  it('is deterministic for the same seed and different for another', async () => {
    const { rngFrom } = await import('../warmup/rng.js');
    const a = rngFrom('x', 'acct', '2026-09-08');
    const b = rngFrom('x', 'acct', '2026-09-08');
    const c = rngFrom('x', 'acct', '2026-09-09');
    const seqA = [a.next(), a.next(), a.int(1, 100)];
    const seqB = [b.next(), b.next(), b.int(1, 100)];
    expect(seqA).toEqual(seqB);
    expect([c.next(), c.next()]).not.toEqual(seqA.slice(0, 2));
  });
});

describe('warmup planner (pure parts)', () => {
  it('ramps, randomises within bounds, honours weekends and throttle', async () => {
    const { computeDayTarget } = await import('../warmup/planner.js');
    const { INSTANCE_DEFAULTS } = await import('../warmup/settings.js');
    const { rngFrom } = await import('../warmup/rng.js');
    const s = { ...INSTANCE_DEFAULTS, randomizePercent: 0 };
    // Tuesday
    const d0 = computeDayTarget(s, 0, 100, '2026-09-08', rngFrom('t'), { poolOk: true });
    expect(d0.target).toBe(3);
    const d5 = computeDayTarget(s, 5, 100, '2026-09-08', rngFrom('t'), { poolOk: true });
    expect(d5.target).toBe(13);
    const d50 = computeDayTarget(s, 50, 100, '2026-09-08', rngFrom('t'), { poolOk: true });
    expect(d50.target).toBe(30);
    expect(d50.rampValue).toBe(30);
    const throttled = computeDayTarget(s, 50, 50, '2026-09-08', rngFrom('t'), { poolOk: true });
    expect(throttled.target).toBe(15);
    // Saturday with weekdaysOnly
    const sat = computeDayTarget({ ...s, weekdaysOnly: true }, 50, 100, '2026-09-12', rngFrom('t'), { poolOk: true });
    expect(sat.target).toBe(0);
    expect(sat.sendingDay).toBe(false);
    const satFactor = computeDayTarget(s, 50, 100, '2026-09-12', rngFrom('t'), { poolOk: true });
    expect(satFactor.target).toBe(9);
    const small = computeDayTarget(s, 50, 100, '2026-09-08', rngFrom('t'), { poolOk: false });
    expect(small.target).toBe(0);
    expect(small.reason).toBe('pool too small');
    // Randomised stays inside ±20%
    for (let i = 0; i < 50; i++) {
      const r = computeDayTarget({ ...s, randomizePercent: 20 }, 50, 100, '2026-09-08', rngFrom('r', i), { poolOk: true });
      expect(r.target).toBeGreaterThanOrEqual(24);
      expect(r.target).toBeLessThanOrEqual(30);
    }
    // Openers leave headroom for replies
    expect(d50.openers).toBeLessThan(d50.target);
    expect(d50.openers).toBeGreaterThan(0);
  });

  it('samples send times inside the window, spaced, off the round minute, deterministically', async () => {
    const { sampleSendTimes } = await import('../warmup/planner.js');
    const { INSTANCE_DEFAULTS } = await import('../warmup/settings.js');
    const { rngFrom } = await import('../warmup/rng.js');
    const { localMinutes, localDate } = await import('../warmup/clock.js');
    const s = { ...INSTANCE_DEFAULTS, timezone: 'Europe/Amsterdam', minGapMinutes: 12 };
    for (let day = 1; day <= 28; day++) {
      const date = `2026-09-${String(day).padStart(2, '0')}`;
      const times = sampleSendTimes(25, s, date, rngFrom('p', date));
      const again = sampleSendTimes(25, s, date, rngFrom('p', date));
      expect(times).toEqual(again);
      expect(times.length).toBe(25);
      for (let i = 0; i < times.length; i++) {
        const t = times[i]!;
        expect(localDate(t, s.timezone)).toBe(date);
        const m = localMinutes(t, s.timezone);
        expect(m).toBeGreaterThanOrEqual(8 * 60);
        expect(m).toBeLessThan(18 * 60 + 30);
        expect(new Date(t).getUTCSeconds()).not.toBe(0);
        if (i > 0) expect(t - times[i - 1]!).toBeGreaterThanOrEqual(12 * 60_000 - 60_000);
      }
    }
    // Too many for the window at the configured gap: gap tightens, nothing dropped
    const tight = sampleSendTimes(50, { ...s, minGapMinutes: 60 }, '2026-09-08', rngFrom('q'));
    expect(tight.length).toBe(50);
    // Nothing before "now" when planning mid-day
    const late = sampleSendTimes(10, s, '2026-09-08', rngFrom('l'), 16 * 60);
    for (const t of late) expect(localMinutes(t, s.timezone)).toBeGreaterThanOrEqual(16 * 60);
  });
});

describe('warmup identity and task queue (db-backed)', () => {
  let orgId: string;
  let accountId: string;

  beforeAll(async () => {
    const { runMigrations, db, schema } = await import('../db/index.js');
    runMigrations();
    const { createOrgWithOwner } = await import('../tenancy/orgs.js');
    const org = createOrgWithOwner({ orgName: 'W', email: 'w@w.test', password: 'password-abc' });
    orgId = org.orgId;
    accountId = 'warm-core-acct';
    const now = Date.now();
    db.insert(schema.accounts)
      .values({ id: accountId, orgId, provider: 'google', email: 'core@example.com', status: 'active', createdAt: now, updatedAt: now })
      .run();
  });

  it('recognises warmup mail by registry, signed header, and body tag — and nothing else', async () => {
    const identity = await import('../warmup/identity.js');
    const { registerMessage } = await import('../warmup/ledger.js');
    const tag = identity.ensureOrgTag(orgId);
    expect(tag).toMatch(/^[A-Z0-9]{7}$/);
    const id = identity.newWarmupMessageId('core@example.com', 'google');
    expect(id.header).toMatch(/^<CA[A-Za-z0-9_-]{52}@example\.com>$/);
    expect(identity.newWarmupMessageId('core@example.com', 'microsoft').header).toMatch(/^<[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}@example\.com>$/);
    registerMessage({
      threadId: 't1', turn: 0, kind: 'open', fromAccountId: accountId, toAccountId: 'other',
      rfcMessageId: id.normalized, subject: 'Hello', contentSource: 'template', localDate: '2026-09-08',
    });
    expect(identity.isWarmupMessage({ messageId: id.header }).via).toBe('registry');
    expect(identity.isWarmupMessage({ messageId: id.header.toUpperCase() }).via).toBe('registry');
    const other = identity.newWarmupMessageId('core@example.com');
    const headerValue = identity.warmupHeaderValue(other.normalized);
    expect(identity.isWarmupMessage({ messageId: other.header, header: (n) => (n === identity.WARMUP_HEADER ? headerValue : null) }).via).toBe('header');
    // Tampered hmac fails
    expect(identity.isWarmupMessage({ messageId: other.header, header: () => 'v1; ' + 'A'.repeat(32) }).warmup).toBe(false);
    expect(identity.isWarmupMessage({ messageId: '<real@customer.com>', text: `hi there\n\n${tag}` }).via).toBe('tag');
    expect(identity.isWarmupMessage({ messageId: '<real@customer.com>', subject: 'Quarterly numbers', text: 'Please find attached.' }).warmup).toBe(false);
    // Listing filter
    const kept = identity.filterSummaries([
      { id: 'a', from: null, to: null, subject: 'Hello', date: null, snippet: null, unread: true, hasAttachments: false, messageId: id.header },
      { id: 'b', from: null, to: null, subject: 'Real', date: null, snippet: `... ${tag}`, unread: true, hasAttachments: false, messageId: '<x@y>' },
      { id: 'c', from: null, to: null, subject: 'Real', date: null, snippet: 'real mail', unread: true, hasAttachments: false, messageId: '<z@y>' },
    ]);
    expect(kept.map((k) => k.id)).toEqual(['c']);
  });

  it('rotating the tag keeps the old one matching', async () => {
    const identity = await import('../warmup/identity.js');
    const old = identity.ensureOrgTag(orgId);
    identity.setOrgTag(orgId, 'NEWTAG99');
    expect(identity.activeTags()).toContain('NEWTAG99');
    expect(identity.activeTags()).toContain(old);
    expect(() => identity.setOrgTag(orgId, 'ab')).toThrow();
  });

  it('enqueues idempotently, claims once, retries with backoff, skips stale sends', async () => {
    const tasks = await import('../warmup/tasks.js');
    const { enableWarmup } = await import('../warmup/state.js');
    enableWarmup(accountId);
    const now = Date.now();
    const first = tasks.enqueueTask({ accountId, kind: 'mark_read', dueAt: now - 1000, idempotencyKey: 'k1', payload: {} });
    const dup = tasks.enqueueTask({ accountId, kind: 'mark_read', dueAt: now - 1000, idempotencyKey: 'k1', payload: {} });
    expect(first).not.toBeNull();
    expect(dup).toBeNull();
    const claimed = tasks.claimTasks('w1');
    expect(claimed.map((t) => t.id)).toEqual([first!.id]);
    expect(tasks.claimTasks('w2')).toEqual([]); // one in flight per account
    const status = tasks.failTask(claimed[0]!, 'boom');
    expect(status).toBe('pending');
    // Backed off into the future, so not claimable now
    expect(tasks.claimTasks('w3')).toEqual([]);
    // A send task far past its window is skipped, an engagement task is not
    tasks.enqueueTask({ accountId, kind: 'send_open', dueAt: now - 3 * 3600_000, idempotencyKey: 'k-old-send', payload: {} });
    tasks.enqueueTask({ accountId, kind: 'cleanup', dueAt: now - 3 * 3600_000, idempotencyKey: 'k-old-clean', payload: {} });
    expect(tasks.skipStaleSendTasks(45)).toBe(1);
    const pending = tasks.pendingTasksFor(accountId).map((t) => t.idempotencyKey);
    expect(pending).toContain('k-old-clean');
    expect(pending).not.toContain('k-old-send');
    // Disabling drops everything pending
    const { disableWarmup } = await import('../warmup/state.js');
    disableWarmup(accountId);
    expect(tasks.pendingTasksFor(accountId)).toEqual([]);
  });

  it('mirrors upstream account status into warmup state and back', async () => {
    const { db, schema } = await import('../db/index.js');
    const { eq } = await import('drizzle-orm');
    const state = await import('../warmup/state.js');
    state.enableWarmup(accountId);
    expect(state.getWarmupAccount(accountId)!.state).toBe('ramping');
    db.update(schema.accounts).set({ status: 'auth_error' }).where(eq(schema.accounts.id, accountId)).run();
    state.syncUpstreamState();
    expect(state.getWarmupAccount(accountId)!.state).toBe('blocked_upstream');
    db.update(schema.accounts).set({ status: 'active' }).where(eq(schema.accounts.id, accountId)).run();
    state.syncUpstreamState();
    expect(state.getWarmupAccount(accountId)!.state).toBe('ramping');
    state.pauseWarmup(accountId);
    expect(state.getWarmupAccount(accountId)!.state).toBe('paused');
    state.resumeWarmup(accountId);
    expect(state.getWarmupAccount(accountId)!.state).toBe('ramping');
    state.autoPauseWarmup(accountId, 'test', 1);
    const row = state.getWarmupAccount(accountId)!;
    expect(row.state).toBe('auto_paused');
    expect(row.throttlePercent).toBe(50);
    // Cooldown over → lifts itself
    state.syncUpstreamState(Date.now() + 2 * 24 * 3600_000);
    expect(state.getWarmupAccount(accountId)!.state).toBe('ramping');
  });
});

describe('warmup mime', () => {
  it('builds an opener with all three markers, a reply with threading and quoting, and an MDN', async () => {
    const { buildWarmupMime, buildMdnMime, quoteBlock, forwardBlock, replySubject, forwardSubject } = await import('../warmup/mime.js');
    const { newWarmupMessageId, WARMUP_HEADER } = await import('../warmup/identity.js');
    const { simpleParser } = await import('mailparser');
    const alice = { email: 'alice@a.test', persona: { firstName: 'Alice', lastName: 'Ash', role: null, company: 'A', signOff: 'Best' }, style: 'gmail' as const };
    const bob = { email: 'bob@b.test', persona: { firstName: 'Bob', lastName: null, role: null, company: null, signOff: null }, style: 'outlook' as const };
    const id = newWarmupMessageId(alice.email);
    const raw = await buildWarmupMime({
      from: alice, to: [bob], subject: 'Quick question', text: 'Hi Bob,\n\nAre you around?\n\nBest\nAlice\n\nTAG1234', html: null,
      messageIdHeader: id.header, normalizedMessageId: id.normalized, requestReceipt: true,
    });
    const parsed = await simpleParser(raw);
    expect(parsed.messageId).toBe(id.header);
    // No marker header of any kind on the wire.
    expect(parsed.headers.get(WARMUP_HEADER.toLowerCase())).toBeUndefined();
    expect([...parsed.headers.keys()].filter((k) => k.startsWith('x-'))).toEqual([]);
    expect(JSON.stringify(parsed.headers.get('disposition-notification-to'))).toContain('alice@a.test');
    expect(parsed.from?.text).toBe('"Alice Ash" <alice@a.test>');
    expect(parsed.text).toContain('TAG1234');

    const original = { fromName: 'Alice Ash', fromEmail: alice.email, to: bob.email, subject: 'Quick question', sentAt: Date.UTC(2026, 8, 8, 9, 12), text: 'Are you around?' };
    const gq = quoteBlock('gmail', original);
    expect(gq.text).toContain('On Tue, 8 Sep 2026 at 9:12 AM, Alice Ash <alice@a.test> wrote:');
    expect(gq.text).toContain('> Are you around?');
    expect(gq.html).toContain('gmail_quote');
    const oq = quoteBlock('outlook', original);
    expect(oq.text).toContain('From: Alice Ash <alice@a.test>');
    expect(oq.text).toContain('Sent: Tuesday, September 8, 2026 9:12 AM');
    expect(forwardBlock('gmail', original).text).toContain('---------- Forwarded message ---------');
    expect(replySubject('Quick question')).toBe('Re: Quick question');
    expect(replySubject('Re: Quick question')).toBe('Re: Quick question');
    expect(forwardSubject('Re: Quick question', 'gmail')).toBe('Fwd: Quick question');
    expect(forwardSubject('Quick question', 'outlook')).toBe('FW: Quick question');

    const replyId = newWarmupMessageId(bob.email);
    const reply = await buildWarmupMime({
      from: bob, to: [alice], subject: 'Re: Quick question', text: 'Yes.' + oq.text, html: null,
      messageIdHeader: replyId.header, normalizedMessageId: replyId.normalized, inReplyTo: id.header, references: [id.header],
    });
    const rp = await simpleParser(reply);
    expect(rp.inReplyTo).toBe(id.header);
    expect(rp.references).toBe(id.header);

    const mdnId = newWarmupMessageId(bob.email);
    const mdn = buildMdnMime({ from: bob, to: alice, originalMessageIdHeader: id.header, originalSubject: 'Quick question', messageIdHeader: mdnId.header, normalizedMessageId: mdnId.normalized, displayedAt: Date.now() });
    const mp = await simpleParser(mdn);
    expect(mp.subject).toBe('Read: Quick question');
    expect(mdn.toString()).toContain('report-type=disposition-notification');
    expect(mdn.toString()).not.toContain('X-OEM');
    expect(mdn.toString()).toContain(`Original-Message-ID: ${id.header}`);
    expect(mdn.toString()).toContain('Disposition: manual-action/MDN-sent-manually; displayed');
  });
});

describe('domain DNS health', () => {
  it('reads SPF, DKIM, DMARC and MX through an injected resolver', async () => {
    const { checkDomain } = await import('../warmup/dns-health.js');
    const records: Record<string, string[]> = {
      'good.test': ['v=spf1 include:_spf.google.com ~all', 'google-site-verification=abc'],
      '_dmarc.good.test': ['v=DMARC1; p=quarantine; rua=mailto:x@good.test'],
      'google._domainkey.good.test': ['v=DKIM1; k=rsa; p=MIIB'],
      'bare.test': [],
    };
    const resolver = {
      txt: async (n: string) => records[n] ?? [],
      mx: async (n: string) => (n === 'good.test' ? [{ exchange: 'aspmx.l.google.com', priority: 1 }] : []),
      cname: async () => [] as string[],
    };
    const good = await checkDomain('good.test', resolver);
    expect(good).toMatchObject({ spfOk: true, dkimOk: true, dmarcOk: true, mxOk: true, dmarcPolicy: 'quarantine', dkimSelectors: ['google'] });
    expect(good.issues).toEqual([]);
    const bare = await checkDomain('bare.test', resolver);
    expect(bare).toMatchObject({ spfOk: false, dkimOk: false, dmarcOk: false, mxOk: false });
    expect(bare.issues.length).toBe(4);
    const weak = await checkDomain('weak.test', {
      txt: async (n) => (n === 'weak.test' ? ['v=spf1 +all'] : n === '_dmarc.weak.test' ? ['v=DMARC1; p=none'] : n === 'selector1._domainkey.weak.test' ? ['v=DKIM1; p=abc'] : []),
      mx: async () => [{ exchange: 'weak-test.mail.protection.outlook.com', priority: 0 }],
      cname: async () => [],
    });
    expect(weak.providers).toEqual(['microsoft']);
    expect(weak.dkimOk).toBe(true);
    expect(weak.dmarcOk).toBe(true);
    expect(weak.issues.some((i) => i.includes('+all'))).toBe(true);
    expect(weak.issues.some((i) => i.includes('p=none'))).toBe(true);
    expect(weak.issues.some((i) => i.includes('spf.protection.outlook.com'))).toBe(true);
    // Microsoft domain with CNAMEs present but no key behind them: the exact
    // "enable DKIM in Defender" situation, named as such.
    const halfway = await checkDomain('half.test', {
      txt: async (n) => (n === 'half.test' ? ['v=spf1 include:spf.protection.outlook.com -all'] : n === '_dmarc.half.test' ? ['v=DMARC1; p=quarantine'] : []),
      mx: async () => [{ exchange: 'half-test.mail.protection.outlook.com', priority: 0 }],
      cname: async (n) => (n.startsWith('selector') ? ['selector1-half-test._domainkey.x.dkim.mail.microsoft'] : []),
    }, ['microsoft']);
    expect(halfway.dkimOk).toBe(false);
    expect(halfway.issues).toEqual([expect.stringContaining('Enable DKIM signing for this domain in Microsoft 365 Defender')]);
    const googleMissing = await checkDomain('g.test', { txt: async () => [], mx: async () => [{ exchange: 'aspmx.l.google.com', priority: 1 }], cname: async () => [] }, ['google']);
    expect(googleMissing.issues.some((i) => i.includes('Google Admin'))).toBe(true);
    expect(googleMissing.issues.some((i) => i.includes('selector1'))).toBe(false);
  });
});

describe('warmup content', () => {
  it('validates LLM output strictly and renders varied but deterministic bodies', async () => {
    const { validateScript } = await import('../warmup/content/llm.js');
    const { renderTurn } = await import('../warmup/content/scripts.js');
    const { rngFrom } = await import('../warmup/rng.js');
    const good = validateScript({ subject: 'Catching {up|on}', register: 'casual', topic: 'x', turns: ['It has been a while since we last spoke and I wanted to see how things are going on your side of the office these days.', 'Things are good here thanks for asking, the new project keeps everyone busy but in a good way overall I would say.'] }, 'en');
    expect(good).not.toBeNull();
    expect(validateScript({ subject: 'Special {offer|deal}', turns: ['Click here https://x.y for a limited time offer that you will not want to miss at all this week.'] }, 'en')).toBeNull();
    expect(validateScript({ subject: 'Hi {there|all}', turns: ['Too short.'] }, 'en')).toBeNull();
    expect(validateScript({ subject: 'Hi [Name]', turns: ['A perfectly ordinary sentence that is long enough to pass the word count requirement for a turn.'] }, 'en')).toBeNull();
    // A subject without a rotating word would repeat verbatim across the pool.
    expect(validateScript({ subject: 'Catching up', turns: ['A perfectly ordinary sentence that is long enough to pass the word count requirement for a turn.'] }, 'en')).toBeNull();
    const from = { firstName: 'Alice', lastName: 'Ash', role: null, company: 'Acme', signOff: 'Best' };
    const to = { firstName: 'Bob', lastName: null, role: null, company: null, signOff: null };
    const a = renderTurn('Are you around this week?', 'en', from, to, rngFrom('r1'), { includeHtml: true, tag: 'ZZ99' });
    const b = renderTurn('Are you around this week?', 'en', from, to, rngFrom('r1'), { includeHtml: true, tag: 'ZZ99' });
    const c = renderTurn('Are you around this week?', 'en', from, to, rngFrom('r2'), { includeHtml: true, tag: 'ZZ99' });
    expect(a.text).toBe(b.text);
    expect(a.text).toContain('Bob');
    expect(a.text.trim().endsWith('ZZ99')).toBe(true);
    expect(a.html).toContain('<p>');
    expect([a.text === c.text, true]).toContain(true); // may differ, must not throw
  });

  it('spins spintax deterministically and rotates common phrases otherwise', async () => {
    const { spin } = await import('../warmup/content/scripts.js');
    const { rngFrom } = await import('../warmup/rng.js');
    const text = 'A {quick|short|brief} question about {next week|Friday}.';
    const a = spin(text, rngFrom('s1'));
    expect(a).toMatch(/^A (quick|short|brief) question about (next week|Friday)\.$/);
    expect(spin(text, rngFrom('s1'))).toBe(a);
    const seen = new Set(Array.from({ length: 30 }, (_, i) => spin(text, rngFrom('s', i))));
    expect(seen.size).toBeGreaterThan(2);
    const plain = 'Thanks, let me know if next week works. Sounds good.';
    const variants = new Set(Array.from({ length: 30 }, (_, i) => spin(plain, rngFrom('p', i))));
    expect(variants.size).toBeGreaterThan(2);
    for (const v of variants) expect(v).not.toContain('{');
  });

  it('salvages complete scripts from truncated model output', async () => {
    const { salvageObjects } = await import('../warmup/content/llm.js');
    const cut = '{"scripts": [{"subject": "A", "turns": ["one \\"quoted\\" {x|y}"]}, {"subject": "B", "turns": ["two"]}, {"subject": "C", "turns": ["cut off he';
    const got = salvageObjects(cut) as { subject: string }[];
    expect(got.map((g) => g.subject)).toEqual(['A', 'B']);
  });

  it('accepts spintax from the model but rejects other braces', async () => {
    const { validateScript } = await import('../warmup/content/llm.js');
    const long = 'It has been a while since we last spoke and I wanted to see how things are going on your side of the office these days.';
    expect(validateScript({ subject: 'Catching {up|on}', turns: [long + ' {Let me know|Tell me} when suits.'] }, 'en')).not.toBeNull();
    expect(validateScript({ subject: 'Hi {there|all}', turns: [long + ' Regards {Name}.'] }, 'en')).toBeNull();
    expect(validateScript({ subject: 'Hi {there|all}', turns: [long + ' {broken|group'] }, 'en')).toBeNull();
  });

  it('derives personas from display names, addresses and domains', async () => {
    const { derivePersona, companyFromDomain } = await import('../warmup/content/persona.js');
    expect(derivePersona({ id: '1', email: 'jane.doe@acme-labs.com', displayName: null })).toMatchObject({ firstName: 'Jane', lastName: 'Doe', company: 'Acme Labs' });
    expect(derivePersona({ id: '1b', email: 'j.doe@acme-labs.com', displayName: null })).toMatchObject({ firstName: 'Doe', lastName: null });
    expect(derivePersona({ id: '2', email: 'info@acme.com', displayName: 'Jane Q Public' })).toMatchObject({ firstName: 'Jane', lastName: 'Public' });
    expect(companyFromDomain('x@gmail.com')).toBeNull();
    expect(derivePersona({ id: '3', email: 'info@gmail.com', displayName: null }).firstName).toBeTruthy();
  });
});
