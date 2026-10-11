import { describe, it, expect, vi, afterEach } from 'vitest';

process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.DATA_DIR = './data-test/oauth-config-error';
process.env.BASE_URL = 'http://localhost:3000';
process.env.SAAS_MODE = 'false';
process.env.MICROSOFT_CLIENT_ID = 'app';
process.env.MICROSOFT_CLIENT_SECRET = 'expired';

const tokenReply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('token endpoint errors about our own app', () => {
  afterEach(() => vi.restoreAllMocks());

  it('are a ProviderConfigError, while a bad grant stays an AuthError', async () => {
    const { refreshTokenGrant } = await import('../providers/oauth.js');
    const { AuthError, ProviderConfigError, isAppSideTokenError } = await import('../providers/errors.js');
    vi.spyOn(globalThis, 'fetch').mockImplementation(tokenReply(401, { error: 'invalid_client', error_description: "AADSTS7000222: The provided client secret keys for app 'x' are expired." }));
    const err = await refreshTokenGrant('microsoft', 'rt').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderConfigError);
    expect(err).not.toBeInstanceOf(AuthError);
    expect((err as InstanceType<typeof ProviderConfigError>).provider).toBe('microsoft');
    expect(String((err as Error).message)).toContain('AADSTS7000222');

    vi.spyOn(globalThis, 'fetch').mockImplementation(tokenReply(400, { error: 'invalid_grant', error_description: 'AADSTS500341: The user account has been deleted' }));
    await expect(refreshTokenGrant('microsoft', 'rt')).rejects.toBeInstanceOf(AuthError);

    expect(isAppSideTokenError('unauthorized_client', undefined)).toBe(true);
    expect(isAppSideTokenError('invalid_request', 'AADSTS7000215: Invalid client secret provided.')).toBe(true);
    expect(isAppSideTokenError('invalid_grant', 'AADSTS70000: The provided value for the input parameter is not valid')).toBe(false);
  });

  it('leave the account active, record the problem once for /healthz, and clear it when a refresh works again', async () => {
    const { db, schema, runMigrations } = await import('../db/index.js');
    runMigrations();
    const { eq } = await import('drizzle-orm');
    const { getAccessToken, saveTokens, currentProviderProblems } = await import('../auth/tokens.js');
    const { ProviderConfigError } = await import('../providers/errors.js');
    const now = Date.now();
    const id = 'acc-ms-config';
    db.insert(schema.accounts).values({ id, orgId: 'org_default', provider: 'microsoft', email: 'cfg@ms.test', displayName: null, status: 'active', createdAt: now, updatedAt: now }).run();
    saveTokens(id, { accessToken: 'old', refreshToken: 'rt', expiresAt: now - 1, scopes: 's' });
    const status = () => db.select({ status: schema.accounts.status }).from(schema.accounts).where(eq(schema.accounts.id, id)).get()!.status;

    vi.spyOn(globalThis, 'fetch').mockImplementation(tokenReply(401, { error: 'invalid_client', error_description: 'AADSTS7000222: expired' }));
    for (let i = 0; i < 3; i++) await expect(getAccessToken(id)).rejects.toBeInstanceOf(ProviderConfigError);
    expect(status()).toBe('active');
    expect(currentProviderProblems()).toMatchObject([{ provider: 'microsoft', failures: 3 }]);
    const rows = () => db.select().from(schema.activityLog).where(eq(schema.activityLog.action, 'provider-config')).all();
    expect(rows().filter((r) => r.status === 'failed')).toHaveLength(1);

    vi.spyOn(globalThis, 'fetch').mockImplementation(tokenReply(200, { access_token: 'new', refresh_token: 'rt2', expires_in: 3600 }));
    expect(await getAccessToken(id)).toBe('new');
    expect(currentProviderProblems()).toEqual([]);
    expect(rows().filter((r) => r.status === 'ok')).toHaveLength(1);
  });
});
