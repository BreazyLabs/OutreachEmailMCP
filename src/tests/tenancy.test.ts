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
    expect(verifyConnectToken(token, 'google')).toMatchObject({ ok: true, orgId: orgA });
    // provider-bound
    expect(verifyConnectToken(token, 'microsoft')).toEqual({ ok: false, reason: 'wrong_provider' });
    expect(verifyConnectToken(token.replace(orgA, 'org_other'))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('keeps the hub link reusable, stable, and revocable', async () => {
    const { createConnectHubLink, revokeConnectLinks, verifyConnectToken } = await import(
      '../auth/connect-links.js'
    );
    const url = createConnectHubLink(orgA);
    // Same URL every time, so the one handed out stays the one shown
    expect(createConnectHubLink(orgA)).toBe(url);
    const token = new URL(url).searchParams.get('token')!;
    // Opening it repeatedly never consumes it, and it works for both providers
    for (let i = 0; i < 3; i++) {
      expect(verifyConnectToken(token, 'google')).toMatchObject({ ok: true, orgId: orgA });
      expect(verifyConnectToken(token, 'microsoft')).toMatchObject({ ok: true, orgId: orgA });
    }
    revokeConnectLinks(orgA);
    expect(verifyConnectToken(token)).toEqual({ ok: false, reason: 'revoked' });
    expect(createConnectHubLink(orgA)).not.toBe(url);
    const fresh = new URL(createConnectHubLink(orgA)).searchParams.get('token')!;
    expect(verifyConnectToken(fresh)).toMatchObject({ ok: true, orgId: orgA });
  });

  it('reuses one connect link across concurrent OAuth flows', async () => {
    const { createOauthState, verifyOauthState } = await import('../auth/connect-links.js');
    // Two mailboxes being added at the same time from the same link: both
    // states must stay valid (no single-slot cookie to overwrite).
    const first = createOauthState('google', orgA, 'link-token');
    const second = createOauthState('google', orgA, 'link-token');
    expect(first).not.toBe(second);
    expect(verifyOauthState('google', first)).toEqual({ orgId: orgA, returnToken: 'link-token' });
    expect(verifyOauthState('google', second)).toEqual({ orgId: orgA, returnToken: 'link-token' });
    expect(verifyOauthState('microsoft', first)).toBeNull(); // provider-bound
    expect(verifyOauthState('google', first.replace(orgA, 'org_other'))).toBeNull();
    expect(verifyOauthState('google', 'garbage')).toBeNull();
    expect(verifyOauthState('google', createOauthState('google', orgA, null))).toEqual({
      orgId: orgA,
      returnToken: null,
    });
  });

  it('retires pre-v2 links when links are revoked', async () => {
    const crypto = await import('node:crypto');
    const { revokeConnectLinks, verifyConnectToken } = await import('../auth/connect-links.js');
    const { createOrgWithOwner } = await import('../tenancy/orgs.js');
    const { config } = await import('../config.js');
    const orgC = createOrgWithOwner({
      orgName: 'C',
      email: 'c@c.test',
      password: 'password-abc',
    }).orgId;
    // A link in the shape minted before link versioning existed
    const expiry = Date.now() + 3600_000;
    const sig = crypto
      .createHmac('sha256', config.masterKey)
      .update(`connect-link:google:${orgC}:${expiry}`)
      .digest('hex');
    const legacy = `${orgC}.${expiry}.${sig}`;
    expect(verifyConnectToken(legacy, 'google')).toMatchObject({ ok: true, orgId: orgC });
    // The connect page has no provider in hand and must still resolve it,
    // otherwise a link already in circulation dead-ends on its result page
    expect(verifyConnectToken(legacy)).toMatchObject({
      ok: true,
      orgId: orgC,
      scope: 'google',
    });
    expect(verifyConnectToken(legacy, 'microsoft')).toEqual({ ok: false, reason: 'malformed' });
    revokeConnectLinks(orgC);
    // Revocation has to be total, or a leaked old link outlives it
    expect(verifyConnectToken(legacy, 'google')).toEqual({ ok: false, reason: 'revoked' });
  });

  it('rejects partial consent grants', async () => {
    const { missingScopes } = await import('../providers/oauth.js');
    const full =
      'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify';
    expect(missingScopes('google', full)).toEqual([]);
    // User unticked "read, compose and send" on the consent screen
    expect(missingScopes('google', 'openid email https://www.googleapis.com/auth/gmail.send')).toEqual(
      ['gmail.modify'],
    );
    expect(missingScopes('microsoft', 'User.Read Mail.Send Mail.ReadWrite')).toEqual([]);
    expect(missingScopes('microsoft', 'User.Read Mail.Send')).toEqual(['Mail.ReadWrite']);
    // No scope info from the provider is not evidence of a partial grant
    expect(missingScopes('google', '')).toEqual([]);
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
