/**
 * Pocket ID sign-in — the way Breazy staff get into this gateway.
 *
 * Pocket ID (`id.internal`) is passkey-only and resolves ONLY on the Breazy
 * tailnet, so this route is deliberately reachable only from there: the
 * browser is redirected to an issuer a public visitor cannot even resolve, and
 * offering them the button would be a dead end. Both routes 404 for anyone
 * else — see `internalSsoAvailable`.
 *
 * Whoever completes the flow lands as a **superadmin**: able to see, enter,
 * create and manage every workspace on the instance. That is the same grant
 * the partner handoff makes, and it rests on the same reasoning — reaching
 * `id.internal` at all already means "on the staff network", and the passkey
 * proves which staff member.
 *
 * Identity is keyed on the `sub` claim, never on email. Email is stored for
 * display and can change; `sub` is what makes a returning operator the same
 * user row.
 *
 * The CA trap: `.internal` certificates come from a private CA that the
 * container does not trust by default. The browser redirect succeeds and then
 * the server-side token exchange fails with a bare `TypeError: fetch failed`
 * and no certificate wording at all. The fix is NODE_EXTRA_CA_CERTS as a real
 * environment variable (see the Dockerfile) — Node reads it at process start,
 * so a value loaded from a .env at runtime is too late to matter.
 */

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { hashPassword } from '../crypto/credentials.js';
import { createUiSession } from './../ui/session.js';
import { internalSsoAvailable } from './internal-network.js';
import { logger } from '../logger.js';
import { logActivity } from '../observability/activity.js';

/** Where Pocket ID sends the browser back. Must match the registered
 *  callback byte for byte — scheme, host, path, no trailing slash. */
export const REDIRECT_URI = `${config.internalBaseUrl}/auth/callback`;

const SCOPES = 'openid profile email';
/** The handshake cookie only has to survive one redirect to the IdP. */
const HANDSHAKE_COOKIE = 'ep_oidc';
const HANDSHAKE_TTL_MS = 10 * 60_000;

/** Discovery is a network call, so it is done once and reused. A failure is
 *  NOT cached: a Pocket ID restart or a CA problem must be retryable without
 *  restarting this process. */
let discovered: Promise<oidc.Configuration> | null = null;

function issuerConfig(): Promise<oidc.Configuration> {
  if (!discovered) {
    discovered = oidc
      .discovery(
        new URL(config.OIDC_ISSUER),
        config.OIDC_CLIENT_ID!,
        config.OIDC_CLIENT_SECRET!,
      )
      .catch((err) => {
        discovered = null;
        throw err;
      });
  }
  return discovered;
}

/** Anything a private-CA TLS failure looks like from inside undici. Node
 *  reports it as a bare `fetch failed`, so the real reason lives in `cause`. */
function explainFetchFailure(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code;
  if (
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
  ) {
    return `cannot verify ${config.OIDC_ISSUER}'s certificate (${code}) — the container is missing the internal root CA; set NODE_EXTRA_CA_CERTS`;
  }
  return e?.cause?.message ?? e?.message ?? 'unknown error';
}

// --- the handshake cookie -------------------------------------------------
// state / nonce / PKCE verifier have to survive the round trip to the IdP.
// They live in a signed cookie rather than server memory so the flow still
// completes if the request comes back to a different process, and so a
// restart mid-login fails cleanly instead of hanging.

interface Handshake {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  exp: number;
}

function sealHandshake(h: Handshake): string {
  const payload = Buffer.from(JSON.stringify(h)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', config.masterKey)
    .update(`oidc:${payload}`)
    .digest('base64url');
  return `${payload}.${sig}`;
}

function openHandshake(raw: string | undefined): Handshake | null {
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  const expected = crypto
    .createHmac('sha256', config.masterKey)
    .update(`oidc:${payload}`)
    .digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const h = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Handshake;
    if (!h.state || !h.verifier || h.exp < Date.now()) return null;
    return h;
  } catch {
    return null;
  }
}

/**
 * Where to land after signing in.
 *
 * A leading slash is not enough on its own: `//evil.test/x` is a
 * protocol-relative URL, so a bare startsWith('/') check turns the callback
 * into an open redirect. Backslashes are rejected too — some clients
 * normalise `/\evil.test` the same way.
 */
export function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/')) return '/ui';
  if (next.startsWith('//') || next.startsWith('/\\')) return '/ui';
  return next;
}

/** The workspace operators nominally belong to; they act inside the others
 *  through the switcher. Shared with the partner handoff on purpose — one
 *  operator signing in both ways is one user row. */
const PLATFORM_ORG_ID = 'org_platform';

function ensurePlatformOrg(): void {
  db.insert(schema.orgs)
    .values({
      id: PLATFORM_ORG_ID,
      name: 'Platform',
      plan: 'pro',
      status: 'active',
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
}

/**
 * Find or create the operator's user row.
 *
 * Match order matters. `sub` first, because that is the real identity. Email
 * is only a fallback for the first sign-in of someone who already exists here
 * (seeded admin, earlier partner handoff) — and it claims that row by writing
 * `sub` onto it, so this path runs exactly once per operator.
 */
function upsertOperator(sub: string, email: string, _name?: string): string {
  ensurePlatformOrg();
  const bySub = db.select().from(schema.users).where(eq(schema.users.oidcSub, sub)).get();
  if (bySub) {
    const patch: Partial<typeof schema.users.$inferInsert> = {};
    if (bySub.email !== email) patch.email = email;
    if (bySub.role !== 'superadmin') patch.role = 'superadmin';
    if (Object.keys(patch).length) {
      db.update(schema.users).set(patch).where(eq(schema.users.id, bySub.id)).run();
    }
    return bySub.id;
  }

  const byEmail = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  if (byEmail) {
    db.update(schema.users)
      .set({ oidcSub: sub, role: 'superadmin' })
      .where(eq(schema.users.id, byEmail.id))
      .run();
    return byEmail.id;
  }

  const id = nanoid();
  db.insert(schema.users)
    .values({
      id,
      orgId: PLATFORM_ORG_ID,
      email,
      // Never used: this identity only ever arrives through the IdP. A random
      // hash is stored so the password path can never match it either.
      passwordHash: hashPassword(crypto.randomBytes(24).toString('base64url')),
      role: 'superadmin',
      oidcSub: sub,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

function denyIfPublic(req: FastifyRequest, reply: FastifyReply): boolean {
  if (internalSsoAvailable(req)) return false;
  // 404, not 403: a public visitor should not learn that internal sign-in
  // exists here at all.
  reply.code(404).send('Not found');
  return true;
}

export function registerPocketIdRoutes(app: FastifyInstance) {
  /** Kick off the flow: mint state/nonce/PKCE, stash them, redirect to Pocket ID. */
  app.get<{ Querystring: { next?: string } }>('/auth/oidc/start', async (req, reply) => {
    if (denyIfPublic(req, reply)) return;

    let issuer: oidc.Configuration;
    try {
      issuer = await issuerConfig();
    } catch (err) {
      const detail = explainFetchFailure(err);
      logger.error({ err, detail }, 'pocket-id: discovery failed');
      logActivity({
        category: 'oauth',
        action: 'pocket-id-discovery',
        status: 'failed',
        error: detail,
      });
      return reply.redirect(
        `/ui/login?error=${encodeURIComponent(`Pocket ID is unreachable: ${detail}`)}`,
      );
    }

    const verifier = oidc.randomPKCECodeVerifier();
    const handshake: Handshake = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      verifier,
      next: safeNext(req.query.next),
      exp: Date.now() + HANDSHAKE_TTL_MS,
    };
    reply.setCookie(HANDSHAKE_COOKIE, sealHandshake(handshake), {
      path: '/auth',
      httpOnly: true,
      sameSite: 'lax',
      secure: true, // only ever reached over https://<app>.internal
      maxAge: HANDSHAKE_TTL_MS / 1000,
    });

    const url = oidc.buildAuthorizationUrl(issuer, {
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      state: handshake.state,
      nonce: handshake.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    return reply.redirect(url.href);
  });

  /** Come back from Pocket ID: exchange the code, establish the session. */
  app.get('/auth/callback', async (req, reply) => {
    if (denyIfPublic(req, reply)) return;

    const fail = (reason: string, err?: unknown) => {
      logger.warn({ err, reason }, 'pocket-id: sign-in failed');
      logActivity({
        category: 'oauth',
        action: 'pocket-id',
        status: 'failed',
        error: reason,
      });
      reply.clearCookie(HANDSHAKE_COOKIE, { path: '/auth' });
      return reply.redirect(`/ui/login?error=${encodeURIComponent(reason)}`);
    };

    const handshake = openHandshake(req.cookies[HANDSHAKE_COOKIE]);
    if (!handshake) return fail('That sign-in attempt expired. Try again.');

    try {
      const issuer = await issuerConfig();
      // The library re-checks state, nonce and PKCE against these; a mismatch
      // throws rather than returning tokens.
      const tokens = await oidc.authorizationCodeGrant(
        issuer,
        new URL(`${config.internalBaseUrl}${req.url}`),
        {
          pkceCodeVerifier: handshake.verifier,
          expectedState: handshake.state,
          expectedNonce: handshake.nonce,
          idTokenExpected: true,
        },
      );
      const claims = tokens.claims();
      const sub = claims?.sub;
      if (!sub) return fail('Pocket ID returned no subject claim.');

      const info = await oidc.fetchUserInfo(issuer, tokens.access_token, sub);
      const email = String(info.email ?? claims.email ?? '').toLowerCase();
      if (!email) return fail('Pocket ID returned no email address.');
      const name = (info.name ?? info.preferred_username ?? undefined) as string | undefined;

      const userId = upsertOperator(sub, email, name);
      reply.clearCookie(HANDSHAKE_COOKIE, { path: '/auth' });
      createUiSession(reply, userId);
      logger.info({ email, sub }, 'pocket-id: superadmin session created');
      logActivity({
        category: 'oauth',
        action: 'pocket-id',
        status: 'ok',
        detail: `superadmin session for ${email}`,
      });
      return reply.redirect(handshake.next);
    } catch (err) {
      return fail(`Sign-in failed: ${explainFetchFailure(err)}`, err);
    }
  });
}
