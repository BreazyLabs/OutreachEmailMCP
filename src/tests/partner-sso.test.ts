import { describe, it, expect } from 'vitest';

process.env.MASTER_KEY = Buffer.alloc(32, 3).toString('base64');
process.env.DATA_DIR = './data-test/partner-sso';
process.env.BASE_URL = 'http://localhost:3000'; // vite injects BASE_URL='/'
process.env.ADMIN_API_KEY = 'test-admin-key-at-least-16-chars';

const { signPartnerToken, verifyPartnerToken } = await import('../auth/partner-sso.js');

const claims = () => ({
  email: 'operator@breazylabs.com',
  name: 'Operator',
  exp: Date.now() + 5 * 60_000,
  nonce: 'abc123',
});

describe('partner SSO handoff', () => {
  it('round-trips a signed token', () => {
    const token = signPartnerToken(claims());
    const verified = verifyPartnerToken(token);
    expect(verified?.email).toBe('operator@breazylabs.com');
  });

  it('rejects a tampered payload', () => {
    const token = signPartnerToken(claims());
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...claims(), email: 'attacker@evil.test' }),
    ).toString('base64url');
    expect(payload).not.toBe(forged);
    // Same signature, different claims — must not verify.
    expect(verifyPartnerToken(`${forged}.${sig}`)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signPartnerToken({ ...claims(), exp: Date.now() - 1000 });
    expect(verifyPartnerToken(token)).toBeNull();
  });

  it('rejects garbage and truncated input', () => {
    expect(verifyPartnerToken('')).toBeNull();
    expect(verifyPartnerToken('nodot')).toBeNull();
    expect(verifyPartnerToken('a.b')).toBeNull();
  });

  it('is not the admin bearer key: a signature cannot be replayed as one', () => {
    const token = signPartnerToken(claims());
    // The signature is derived, so it must not equal the configured key.
    expect(token.split('.')[1]).not.toBe(process.env.ADMIN_API_KEY);
    expect(token).not.toContain(process.env.ADMIN_API_KEY as string);
  });
});
