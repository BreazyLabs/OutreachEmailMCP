import { describe, it, expect, beforeAll } from 'vitest';

process.env.MASTER_KEY = Buffer.alloc(32, 21).toString('base64');
process.env.DATA_DIR = './data-test/send-idem';
process.env.BASE_URL = 'http://localhost:3000';
process.env.SAAS_MODE = 'false';

describe('send idempotency on caller Message-ID', () => {
  let orgId: string;
  beforeAll(async () => {
    const { runMigrations, db, schema } = await import('../db/index.js');
    runMigrations();
    const { createOrgWithOwner } = await import('../tenancy/orgs.js');
    orgId = createOrgWithOwner({ orgName: 'Idem', email: 'o@idem.test', password: 'pw-pw-pw-pw-1' }).orgId;
    const now = Date.now();
    db.insert(schema.accounts).values({ id: 'ia1', orgId, provider: 'google', email: 's@idem.test', displayName: null, status: 'active', createdAt: now, updatedAt: now }).run();
  });

  it('finds a prior job by normalised Message-ID within the window, any status', async () => {
    const { enqueueSend, findRecentJobByMessageId } = await import('../queue/sendQueue.js');
    const raw = Buffer.from('Message-ID: <cs-42@thread.breazyleads.com>\r\nSubject: hi\r\n\r\nbody');
    const job = enqueueSend({ accountId: 'ia1', source: 'api', raw, envelope: { from: 's@idem.test', to: ['x@to.test'] }, subject: 'hi' });
    // exact, bracket-insensitive and case-insensitive all match the same job
    expect(findRecentJobByMessageId('ia1', '<cs-42@thread.breazyleads.com>')?.id).toBe(job.id);
    expect(findRecentJobByMessageId('ia1', 'CS-42@thread.breazyleads.com')?.id).toBe(job.id);
    // a different id, another mailbox, and an expired window all miss
    expect(findRecentJobByMessageId('ia1', '<cs-99@thread.breazyleads.com>')).toBeNull();
    expect(findRecentJobByMessageId('other', '<cs-42@thread.breazyleads.com>')).toBeNull();
    expect(findRecentJobByMessageId('ia1', '<cs-42@thread.breazyleads.com>', 0)).toBeNull();
  });

  it('the send route returns the first job with deduped:true on a resubmission, and does not enqueue twice', async () => {
    const Fastify = (await import('fastify')).default;
    const { registerSendRoutes } = await import('../api/messages-send.js');
    const { db, schema } = await import('../db/index.js');
    const { and, eq } = await import('drizzle-orm');
    const app = Fastify();
    // stub the api-key context this route reads
    app.addHook('preHandler', async (req) => { (req as any).orgId = orgId; (req as any).scopes = ['*']; });
    await app.register(async (api) => registerSendRoutes(api as any), { prefix: '/api/v1' });

    const payload = { to: 'x@to.test', subject: 'campaign', text: 'hello', messageId: '<cs-777@thread.breazyleads.com>' };
    const first = await app.inject({ method: 'POST', url: '/api/v1/accounts/ia1/messages', payload });
    expect(first.statusCode).toBe(202);
    const a = first.json();
    expect(a.deduped).toBeUndefined();
    expect(a.messageId).toBe('<cs-777@thread.breazyleads.com>');

    const second = await app.inject({ method: 'POST', url: '/api/v1/accounts/ia1/messages', payload });
    const b = second.json();
    expect(b.deduped).toBe(true);
    expect(b.jobId).toBe(a.jobId);
    expect(b.messageId).toBe('<cs-777@thread.breazyleads.com>');

    const jobs = db.select().from(schema.sendJobs).where(and(eq(schema.sendJobs.accountId, 'ia1'), eq(schema.sendJobs.subject, 'campaign'))).all();
    expect(jobs.length).toBe(1);
    await app.close();
  });

  it('without a caller Message-ID, every submission enqueues (generated ids are unique)', async () => {
    const Fastify = (await import('fastify')).default;
    const { registerSendRoutes } = await import('../api/messages-send.js');
    const { db, schema } = await import('../db/index.js');
    const { and, eq } = await import('drizzle-orm');
    const app = Fastify();
    app.addHook('preHandler', async (req) => { (req as any).orgId = orgId; (req as any).scopes = ['*']; });
    await app.register(async (api) => registerSendRoutes(api as any), { prefix: '/api/v1' });
    const payload = { to: 'x@to.test', subject: 'nokey', text: 'hi' };
    await app.inject({ method: 'POST', url: '/api/v1/accounts/ia1/messages', payload });
    await app.inject({ method: 'POST', url: '/api/v1/accounts/ia1/messages', payload });
    const jobs = db.select().from(schema.sendJobs).where(and(eq(schema.sendJobs.accountId, 'ia1'), eq(schema.sendJobs.subject, 'nokey'))).all();
    expect(jobs.length).toBe(2);
    await app.close();
  });
});

describe('GET send-jobs?messageId= lookup', () => {
  let orgId: string;
  beforeAll(async () => {
    const { runMigrations, db, schema } = await import('../db/index.js');
    runMigrations();
    const { createOrgWithOwner } = await import('../tenancy/orgs.js');
    orgId = createOrgWithOwner({ orgName: 'Lookup', email: 'o@lookup.test', password: 'pw-pw-pw-pw-1' }).orgId;
    const now = Date.now();
    db.insert(schema.accounts).values({ id: 'lk1', orgId, provider: 'google', email: 's@lookup.test', displayName: null, status: 'active', createdAt: now, updatedAt: now }).run();
  });

  it('returns the job for a known Message-ID and 404 for an unknown one', async () => {
    const Fastify = (await import('fastify')).default;
    const { registerSendLogRoutes } = await import('../api/send-log.js');
    const { enqueueSend } = await import('../queue/sendQueue.js');
    const app = Fastify();
    app.addHook('preHandler', async (req) => { (req as any).orgId = orgId; (req as any).scopes = ['*']; });
    await app.register(async (api) => registerSendLogRoutes(api as any), { prefix: '/api/v1' });
    const raw = Buffer.from('Message-ID: <cs-lookup@thread.breazyleads.com>\r\nSubject: s\r\n\r\nb');
    const job = enqueueSend({ accountId: 'lk1', source: 'api', raw, envelope: { from: 's@lookup.test', to: ['x@to.test'] }, subject: 's' });
    const hit = await app.inject({ method: 'GET', url: '/api/v1/accounts/lk1/send-jobs?messageId=' + encodeURIComponent('CS-LOOKUP@thread.breazyleads.com') });
    expect(hit.statusCode).toBe(200);
    expect(hit.json().id).toBe(job.id);
    expect(hit.json().messageId).toBe('<cs-lookup@thread.breazyleads.com>');
    const miss = await app.inject({ method: 'GET', url: '/api/v1/accounts/lk1/send-jobs?messageId=' + encodeURIComponent('<cs-none@thread.breazyleads.com>') });
    expect(miss.statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/api/v1/accounts/lk1/send-jobs' });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json())).toBe(true);
    await app.close();
  });
});
