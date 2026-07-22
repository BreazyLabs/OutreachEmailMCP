import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.DATA_DIR = './data-test/provider-retry';
process.env.BASE_URL = 'http://localhost:3000'; // vite injects BASE_URL='/'

// Stub the token store so the provider doesn't hit the real OAuth path
vi.mock('../auth/tokens.js', () => ({
  getAccessToken: async () => 'fake-access-token',
}));

let accountId: string;

beforeAll(async () => {
  const { runMigrations, db, schema } = await import('../db/index.js');
  runMigrations();
  const { createOrgWithOwner } = await import('../tenancy/orgs.js');
  const org = createOrgWithOwner({ orgName: 'R', email: 'r@r.test', password: 'password-abc' });
  const now = Date.now();
  accountId = 'retry-acct';
  db.insert(schema.accounts)
    .values({
      id: accountId,
      orgId: org.orgId,
      provider: 'google',
      email: 'retry@gmail.com',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(status: number, body: object, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('Gmail transient-error handling', () => {
  it('retries a 429 on an idempotent GET and eventually succeeds', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(String(input));
      // Fail twice with 429, then succeed — with a tiny Retry-After so the
      // test stays fast
      if (calls.length <= 2) {
        return jsonResponse(
          429,
          { error: { code: 429, message: 'Too many concurrent requests for user.' } },
          { 'Retry-After': '0' },
        );
      }
      return jsonResponse(200, { historyId: '12345' });
    });

    const { googleProvider } = await import('../providers/google.js');
    const cursor = await googleProvider.initCursor(accountId);
    expect(cursor).toBe('12345');
    expect(calls.length).toBe(3); // 2 retries + success
  }, 15_000);

  it('gives up after the retry budget and surfaces the error', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse(
        429,
        { error: { code: 429, message: 'rateLimitExceeded' } },
        { 'Retry-After': '0' },
      ),
    );
    const { googleProvider } = await import('../providers/google.js');
    await expect(googleProvider.initCursor(accountId)).rejects.toThrow(/429|Retryable/i);
  }, 15_000);

  it('does not retry a non-idempotent send (sendRaw)', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++;
      return jsonResponse(429, { error: { code: 429, message: 'rate' } }, { 'Retry-After': '0' });
    });
    const { googleProvider } = await import('../providers/google.js');
    await expect(googleProvider.sendRaw(accountId, Buffer.from('raw'))).rejects.toThrow();
    expect(calls).toBe(1); // sends are not replayed
  }, 15_000);
});
