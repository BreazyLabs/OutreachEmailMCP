import { describe, it, expect, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

process.env.MASTER_KEY = Buffer.alloc(32, 5).toString('base64');
process.env.DATA_DIR = './data-test/internal-network';
process.env.BASE_URL = 'https://mail.example.com'; // the PUBLIC hostname
process.env.INTERNAL_HOSTNAME = 'emailproxy.internal';
process.env.INTERNAL_GATEWAY_SECRET = 'gateway-secret-value';
process.env.OIDC_CLIENT_ID = 'client-id';
process.env.OIDC_CLIENT_SECRET = 'client-secret';

const { isInternalRequest, internalSsoAvailable } = await import(
  '../auth/internal-network.js'
);

const req = (headers: Record<string, string>) =>
  ({ headers }) as unknown as FastifyRequest;

const SECRET = 'gateway-secret-value';

describe('internal request detection', () => {
  it('accepts the gateway: right host AND right secret', () => {
    expect(
      isInternalRequest(
        req({ host: 'emailproxy.internal', 'x-internal-gateway': SECRET }),
      ),
    ).toBe(true);
  });

  it('accepts a host carrying the gateway port', () => {
    expect(
      isInternalRequest(
        req({ host: 'emailproxy.internal:443', 'x-internal-gateway': SECRET }),
      ),
    ).toBe(true);
  });

  // The attack that made this a real vulnerability elsewhere: a public request
  // that simply sets the trust header.
  it('rejects the secret presented on the public hostname', () => {
    expect(
      isInternalRequest(
        req({ host: 'mail.example.com', 'x-internal-gateway': SECRET }),
      ),
    ).toBe(false);
  });

  it('rejects the internal host without the secret', () => {
    expect(isInternalRequest(req({ host: 'emailproxy.internal' }))).toBe(false);
  });

  it('rejects a wrong secret', () => {
    expect(
      isInternalRequest(
        req({ host: 'emailproxy.internal', 'x-internal-gateway': 'guessed' }),
      ),
    ).toBe(false);
  });

  it('rejects a lookalike host', () => {
    expect(
      isInternalRequest(
        req({ host: 'emailproxy.internal.evil.test', 'x-internal-gateway': SECRET }),
      ),
    ).toBe(false);
  });

  it('rejects a request with no host at all', () => {
    expect(isInternalRequest(req({ 'x-internal-gateway': SECRET }))).toBe(false);
  });

  it('gates Pocket ID sign-in on the same check', () => {
    expect(
      internalSsoAvailable(
        req({ host: 'emailproxy.internal', 'x-internal-gateway': SECRET }),
      ),
    ).toBe(true);
    expect(internalSsoAvailable(req({ host: 'mail.example.com' }))).toBe(false);
  });
});

describe('fail-closed without a configured secret', () => {
  it('rejects everything when INTERNAL_GATEWAY_SECRET is unset', async () => {
    // A fresh module graph, so config is re-parsed without the secret.
    delete process.env.INTERNAL_GATEWAY_SECRET;
    process.env.DATA_DIR = './data-test/internal-network-open';
    vi.resetModules();
    const fresh = await import('../auth/internal-network.js');
    expect(
      fresh.isInternalRequest(
        req({ host: 'emailproxy.internal', 'x-internal-gateway': SECRET }),
      ),
    ).toBe(false);
    // Nothing may be smuggled in by omitting the header either.
    expect(fresh.isInternalRequest(req({ host: 'emailproxy.internal' }))).toBe(false);
    expect(fresh.internalSsoAvailable(req({ host: 'emailproxy.internal' }))).toBe(false);
    process.env.INTERNAL_GATEWAY_SECRET = SECRET;
  });
});

describe('post-login redirect target', () => {
  it('keeps ordinary in-app paths', async () => {
    const { safeNext } = await import('../auth/pocket-id.js');
    expect(safeNext('/ui/apikeys')).toBe('/ui/apikeys');
    expect(safeNext('/ui?tab=2')).toBe('/ui?tab=2');
  });

  it('refuses to bounce the browser off-site', async () => {
    const { safeNext } = await import('../auth/pocket-id.js');
    // Protocol-relative: starts with '/', but leaves the origin.
    expect(safeNext('//evil.test/phish')).toBe('/ui');
    expect(safeNext('/\\evil.test')).toBe('/ui');
    expect(safeNext('https://evil.test')).toBe('/ui');
    expect(safeNext(undefined)).toBe('/ui');
    expect(safeNext('')).toBe('/ui');
  });
});
