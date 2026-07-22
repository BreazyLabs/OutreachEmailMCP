import crypto from 'node:crypto';
import { config } from '../config.js';
import type { ProviderName } from '../providers/oauth.js';

// Stateless signed links that let someone open the OAuth consent screen for
// adding an account WITHOUT an admin UI session. The org id is embedded so
// link-based connects land in the right tenant. Token =
// <orgId>.<expiryMs>.<hmac(masterKey, provider + orgId + expiry)>.

function sign(provider: ProviderName, orgId: string, expiresAtMs: number): string {
  return crypto
    .createHmac('sha256', config.masterKey)
    .update(`connect-link:${provider}:${orgId}:${expiresAtMs}`)
    .digest('hex');
}

export function createConnectLink(
  provider: ProviderName,
  orgId: string,
  expiresInHours = 168,
): string {
  const expiresAtMs = Date.now() + expiresInHours * 3600_000;
  const token = `${orgId}.${expiresAtMs}.${sign(provider, orgId, expiresAtMs)}`;
  return `${config.BASE_URL.replace(/\/$/, '')}/auth/${provider}/start?token=${token}`;
}

// Returns the org id the link was minted for, or null if invalid/expired.
export function verifyConnectToken(provider: ProviderName, token: string): string | null {
  const [orgId, expiryRaw, sig] = token.split('.');
  if (!orgId || !expiryRaw || !sig) return null;
  const expiresAtMs = Number(expiryRaw);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) return null;
  const expected = sign(provider, orgId, expiresAtMs);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return orgId;
}
