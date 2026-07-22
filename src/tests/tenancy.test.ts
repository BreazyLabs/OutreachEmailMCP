import { describe, it, expect, beforeAll } from 'vitest';

process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.DATA_DIR = './data-test/tenancy';
process.env.BASE_URL = 'http://localhost:3000'; // vite injects BASE_URL='/'
process.env.SAAS_MODE = 'true';
process.env.PLAN_FREE_MAX_ACCOUNTS = '1';
process.env.PLAN_FREE_DAILY_SENDS = '2';

describe('tenancy', () => {
  let orgA: string;

  beforeAll(async () => {
    const { runMigrations } = await import('../db/index.js');
    runMigrations();
    const { createOrgWithOwner } = await import('../tenancy/orgs.js');
    orgA = createOrgWithOwner({ orgName: 'A', email: 'a@a.test', password: 'password-abc' }).orgId;
  });

  it('authenticates users with scrypt passwords', async () => {
    const { hashPassword, verifyPassword } = await import('../crypto/credentials.js');
    const stored = hashPassword('hunter2hunter2');
    expect(verifyPassword('hunter2hunter2', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
  });

  it('embeds and verifies org in connect links', async () => {
    const { createConnectLink, verifyConnectToken } = await import('../auth/connect-links.js');
    const url = createConnectLink('google', orgA, 1);
    const token = new URL(url).searchParams.get('token')!;
    expect(verifyConnectToken('google', token)).toBe(orgA);
    expect(verifyConnectToken('microsoft', token)).toBeNull(); // provider-bound
    expect(verifyConnectToken('google', token.replace(orgA, 'org_other'))).toBeNull();
  });

  it('enforces account and send quotas per plan', async () => {
    const { assertCanAddAccount, assertCanSend, QuotaError } = await import(
      '../tenancy/orgs.js'
    );
    const { db, schema } = await import('../db/index.js');
    const { nanoid } = await import('nanoid');
    const now = Date.now();

    expect(() => assertCanAddAccount(orgA)).not.toThrow();
    const accountId = nanoid();
    db.insert(schema.accounts)
      .values({
        id: accountId,
        orgId: orgA,
        provider: 'google',
        email: `${accountId}@test.com`,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // free plan capped at 1 account
    expect(() => assertCanAddAccount(orgA)).toThrow(QuotaError);

    // free plan capped at 2 sends/24h
    expect(() => assertCanSend(orgA)).not.toThrow();
    for (let i = 0; i < 2; i++) {
      db.insert(schema.sendJobs)
        .values({
          id: nanoid(),
          accountId,
          source: 'api',
          status: 'sent',
          rawPath: null,
          envelopeJson: '{}',
          nextAttemptAt: now,
          createdAt: now,
        })
        .run();
    }
    expect(() => assertCanSend(orgA)).toThrow(QuotaError);
  });

  it('scopes quota counting to the org', async () => {
    const { assertCanSend, createOrgWithOwner } = await import('../tenancy/orgs.js');
    const orgB = createOrgWithOwner({
      orgName: 'B',
      email: 'b@b.test',
      password: 'password-abc',
    }).orgId;
    // org A is at its limit; org B is untouched
    expect(() => assertCanSend(orgB)).not.toThrow();
  });
});

describe('stripe webhook signature', () => {
  it('accepts a valid signature and rejects tampering', async () => {
    const { verifyStripeSignature } = await import('../billing/stripe.js');
    const crypto = await import('node:crypto');
    const secret = 'whsec_test';
    const payload = Buffer.from('{"type":"checkout.session.completed"}');
    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto
      .createHmac('sha256', secret)
      .update(`${t}.${payload.toString()}`)
      .digest('hex');
    expect(verifyStripeSignature(payload, `t=${t},v1=${v1}`, secret)).toBe(true);
    expect(verifyStripeSignature(Buffer.from('{}'), `t=${t},v1=${v1}`, secret)).toBe(false);
    const stale = t - 3600;
    const staleSig = crypto
      .createHmac('sha256', secret)
      .update(`${stale}.${payload.toString()}`)
      .digest('hex');
    expect(verifyStripeSignature(payload, `t=${stale},v1=${staleSig}`, secret)).toBe(false);
  });
});
