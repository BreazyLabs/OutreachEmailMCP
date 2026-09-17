import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

process.env.MASTER_KEY = Buffer.alloc(32, 23).toString('base64');
process.env.DATA_DIR = './data-test/send-reliability';
process.env.BASE_URL = 'http://localhost:3000';
process.env.SAAS_MODE = 'false';

vi.mock('../auth/tokens.js', () => ({ getAccessToken: async () => 'fake-token' }));

let orgId: string;
beforeAll(async () => {
  const { runMigrations, db, schema } = await import('../db/index.js');
  runMigrations();
  const { createOrgWithOwner } = await import('../tenancy/orgs.js');
  orgId = createOrgWithOwner({ orgName: 'Rel', email: 'o@rel.test', password: 'pw-pw-pw-pw-1' }).orgId;
  const now = Date.now();
  db.insert(schema.accounts).values({ id: 'rl1', orgId, provider: 'google', email: 'g@rel.test', status: 'active', createdAt: now, updatedAt: now }).run();
});
afterEach(() => vi.restoreAllMocks());

describe('transient network errors are retryable, not permanent', () => {
  it('a thrown fetch (ECONNRESET / timeout) surfaces as RetryableError from a send', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new TypeError('fetch failed'); });
    const { googleProvider } = await import('../providers/google.js');
    const { RetryableError } = await import('../providers/errors.js');
    await expect(googleProvider.sendRaw('rl1', Buffer.from('raw'))).rejects.toBeInstanceOf(RetryableError);
  });

  it('findSentMessageId queries the provider and returns the id or null', async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      seen.push(String(u));
      const has = String(u).includes('cs-here');
      return new Response(JSON.stringify({ messages: has ? [{ id: 'gm-1' }] : [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const { googleProvider } = await import('../providers/google.js');
    expect(await googleProvider.findSentMessageId('rl1', '<cs-here@thread.breazyleads.com>')).toBe('gm-1');
    expect(seen[0]).toMatch(/rfc822msgid/);
    expect(seen[0]).not.toContain('%3C'); // brackets stripped for Gmail
    expect(await googleProvider.findSentMessageId('rl1', '<cs-gone@thread.breazyleads.com>')).toBeNull();
  });
});

describe('the worker does not resend a re-dispatched job that already went out', () => {
  async function seedAccount(id: string) {
    const { db, schema } = await import('../db/index.js');
    db.insert(schema.accounts).values({ id, orgId, provider: 'google', email: id + '@rel.test', status: 'active', createdAt: Date.now(), updatedAt: Date.now() }).run();
  }

  it('adopts the existing message on re-dispatch instead of sending twice', async () => {
    await seedAccount('rl-adopt');
    const { enqueueSend, claimJobs, findRecentJobByMessageId } = await import('../queue/sendQueue.js');
    const { processJob } = await import('../queue/worker.js');
    const { sqlite } = await import('../db/index.js');

    const sendRaw = vi.fn(async () => 'should-not-be-called');
    const findSentMessageId = vi.fn(async () => 'gm-existing');
    vi.spyOn(await import('../providers/index.js'), 'providerFor').mockReturnValue({ sendRaw, findSentMessageId, maxRawSize: 25 * 1024 * 1024 } as never);

    enqueueSend({ accountId: 'rl-adopt', source: 'api', raw: Buffer.from('Message-ID: <cs-redis@thread.breazyleads.com>\r\nSubject: s\r\n\r\nb'), envelope: { from: 'g@rel.test', to: ['x@to.test'] }, subject: 's' });
    claimJobs('w1');                                                    // dispatch_attempts -> 1
    sqlite.prepare("UPDATE send_jobs SET status='queued', locked_at=NULL WHERE account_id='rl-adopt'").run();
    const reclaimed = claimJobs('w2')[0]!;                             // dispatch_attempts -> 2
    expect(reclaimed.dispatchAttempts).toBe(2);

    await processJob(reclaimed);
    expect(findSentMessageId).toHaveBeenCalledOnce();
    expect(sendRaw).not.toHaveBeenCalled();
    const job = findRecentJobByMessageId('rl-adopt', '<cs-redis@thread.breazyleads.com>')!;
    expect(job.status).toBe('sent');
    expect(job.providerMessageId).toBe('gm-existing');
  });

  it('a first dispatch (dispatch_attempts=1) sends normally without the provider check', async () => {
    await seedAccount('rl-fresh');
    const { enqueueSend, claimJobs } = await import('../queue/sendQueue.js');
    const { processJob } = await import('../queue/worker.js');
    const sendRaw = vi.fn(async () => 'gm-new');
    const findSentMessageId = vi.fn(async () => null);
    vi.spyOn(await import('../providers/index.js'), 'providerFor').mockReturnValue({ sendRaw, findSentMessageId, maxRawSize: 25 * 1024 * 1024 } as never);
    enqueueSend({ accountId: 'rl-fresh', source: 'api', raw: Buffer.from('Message-ID: <cs-fresh@thread.breazyleads.com>\r\nSubject: s\r\n\r\nb'), envelope: { from: 'g@rel.test', to: ['x@to.test'] }, subject: 's' });
    const job = claimJobs('w3')[0]!;
    expect(job.dispatchAttempts).toBe(1);
    await processJob(job);
    expect(findSentMessageId).not.toHaveBeenCalled();
    expect(sendRaw).toHaveBeenCalledOnce();
  });
});
