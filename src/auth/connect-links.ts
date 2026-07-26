import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import type { ProviderName } from '../providers/oauth.js';

// Stateless signed links that let someone open the OAuth consent screen for
// adding an account WITHOUT an admin UI session. Nothing is consumed when a
// link is used: the same URL is meant to be opened once per mailbox, by a
// person or an automation, for as long as it stays valid.
//
// Token = <scope>.<orgId>.<version>.<expiryMs>.<hmac>, where scope is a
// provider name or 'any' (a hub link that offers every configured provider),
// expiryMs 0 means "no expiry", and version is the org's connect-link
// generation — bumping it revokes every link already handed out.

export type LinkScope = ProviderName | 'any';

function hmac(payload: string): string {
  return crypto.createHmac('sha256', config.masterKey).update(payload).digest('hex');
}

function sameSig(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function isScope(v: string): v is LinkScope {
  return v === 'google' || v === 'microsoft' || v === 'any';
}

function sign(scope: LinkScope, orgId: string, version: number, expiresAtMs: number): string {
  return hmac(`connect-link:v2:${scope}:${orgId}:${version}:${expiresAtMs}`);
}

// Pre-v2 links were provider-scoped, always expiring, and unversioned. Kept so
// links already in circulation keep working after an upgrade.
function signLegacy(provider: ProviderName, orgId: string, expiresAtMs: number): string {
  return hmac(`connect-link:${provider}:${orgId}:${expiresAtMs}`);
}

export function connectLinkVersion(orgId: string): number {
  const row = db
    .select({ v: schema.orgs.connectLinkVersion })
    .from(schema.orgs)
    .where(eq(schema.orgs.id, orgId))
    .get();
  return row?.v ?? 0;
}

// Invalidates every connect link issued for this org so far.
export function revokeConnectLinks(orgId: string): void {
  db.update(schema.orgs)
    .set({ connectLinkVersion: sql`${schema.orgs.connectLinkVersion} + 1` })
    .where(eq(schema.orgs.id, orgId))
    .run();
}

function mintToken(scope: LinkScope, orgId: string, expiresInHours: number): string {
  const expiresAtMs = expiresInHours > 0 ? Date.now() + expiresInHours * 3600_000 : 0;
  const version = connectLinkVersion(orgId);
  return `${scope}.${orgId}.${version}.${expiresAtMs}.${sign(scope, orgId, version, expiresAtMs)}`;
}

function baseUrl(): string {
  return config.BASE_URL.replace(/\/$/, '');
}

// Provider-specific link: opens that provider's consent screen directly.
export function createConnectLink(
  provider: ProviderName,
  orgId: string,
  expiresInHours = config.CONNECT_LINK_TTL_HOURS,
): string {
  return `${baseUrl()}/auth/${provider}/start?token=${mintToken(provider, orgId, expiresInHours)}`;
}

// Hub link: a durable onboarding page listing what's connected and offering
// every configured provider. Non-expiring by default and deterministic, so the
// dashboard shows the same URL every time until it is revoked.
export function createConnectHubLink(orgId: string, expiresInHours = 0): string {
  return `${baseUrl()}/connect?token=${mintToken('any', orgId, expiresInHours)}`;
}

export type TokenFailure = 'malformed' | 'expired' | 'revoked' | 'wrong_provider';
export type TokenResult =
  | { ok: true; orgId: string; scope: LinkScope; token: string }
  | { ok: false; reason: TokenFailure };

// Verifies a connect token. `provider` restricts the result to links that may
// open that provider's flow; omit it when only the workspace matters.
export function verifyConnectToken(token: string, provider?: ProviderName): TokenResult {
  const parts = token.split('.');

  // Pre-v2 form: <orgId>.<expiryMs>.<hmac>, only ever minted per-provider.
  // The provider is inside the signature and not in the token, so when the
  // caller has no provider in hand (the connect page, which any link may
  // return to) each one is tried and the match decides the scope.
  if (parts.length === 3) {
    const orgId = parts[0] ?? '';
    const expiresAtMs = Number(parts[1]);
    const sig = parts[2] ?? '';
    if (!orgId || !sig || !Number.isFinite(expiresAtMs)) return { ok: false, reason: 'malformed' };
    const candidates: ProviderName[] = provider ? [provider] : ['google', 'microsoft'];
    const matched = candidates.find((p) => sameSig(sig, signLegacy(p, orgId, expiresAtMs)));
    if (!matched) return { ok: false, reason: 'malformed' };
    provider = matched;
    if (expiresAtMs < Date.now()) return { ok: false, reason: 'expired' };
    // Legacy tokens carry no version, so revocation would slip past them.
    // Any revocation at all retires the whole pre-v2 generation.
    if (connectLinkVersion(orgId) !== 0) return { ok: false, reason: 'revoked' };
    return { ok: true, orgId, scope: provider, token };
  }

  if (parts.length !== 5) return { ok: false, reason: 'malformed' };
  const scope = parts[0] ?? '';
  const orgId = parts[1] ?? '';
  const version = Number(parts[2]);
  const expiresAtMs = Number(parts[3]);
  const sig = parts[4] ?? '';
  if (!isScope(scope) || !orgId || !sig) return { ok: false, reason: 'malformed' };
  if (!Number.isFinite(version) || !Number.isFinite(expiresAtMs)) {
    return { ok: false, reason: 'malformed' };
  }
  if (!sameSig(sig, sign(scope, orgId, version, expiresAtMs))) {
    return { ok: false, reason: 'malformed' };
  }
  // Signature is good from here on, so the remaining failures are specific
  // enough to explain to whoever opened the link.
  if (expiresAtMs !== 0 && expiresAtMs < Date.now()) return { ok: false, reason: 'expired' };
  if (version !== connectLinkVersion(orgId)) return { ok: false, reason: 'revoked' };
  if (provider && scope !== 'any' && scope !== provider) {
    return { ok: false, reason: 'wrong_provider' };
  }
  return { ok: true, orgId, scope, token };
}

// OAuth `state` is signed the same way rather than mirrored into a cookie: one
// connect link is routinely opened several times (and in several tabs at once)
// to add several mailboxes, and a single-slot state cookie makes every flow but
// the newest fail. The signature carries the org, the connect token to return
// to (so the next mailbox is one click away), and its own expiry, so
// concurrent and slow consent screens both work.
const STATE_TTL_MS = 30 * 60_000;
// Connect tokens contain '.', so state fields are joined with a character that
// cannot appear in a nanoid, a hex digest, or a scope name.
const STATE_SEP = '~';

function signState(
  provider: ProviderName,
  nonce: string,
  orgId: string,
  returnToken: string,
  expiresAtMs: number,
): string {
  return hmac(`oauth-state:${provider}:${nonce}:${orgId}:${returnToken}:${expiresAtMs}`);
}

export function createOauthState(
  provider: ProviderName,
  orgId: string,
  returnToken: string | null,
): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAtMs = Date.now() + STATE_TTL_MS;
  const ret = returnToken ?? '';
  return [
    nonce,
    orgId,
    ret,
    String(expiresAtMs),
    signState(provider, nonce, orgId, ret, expiresAtMs),
  ].join(STATE_SEP);
}

export function verifyOauthState(
  provider: ProviderName,
  state: string,
): { orgId: string; returnToken: string | null } | null {
  const parts = state.split(STATE_SEP);
  if (parts.length !== 5) return null;
  const nonce = parts[0] ?? '';
  const orgId = parts[1] ?? '';
  const ret = parts[2] ?? '';
  const sig = parts[4] ?? '';
  if (!nonce || !orgId || !sig) return null;
  const expiresAtMs = Number(parts[3]);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) return null;
  if (!sameSig(sig, signState(provider, nonce, orgId, ret, expiresAtMs))) return null;
  return { orgId, returnToken: ret || null };
}
