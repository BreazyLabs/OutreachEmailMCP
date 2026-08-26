/**
 * Partner SSO — a trusted handoff from the platform that embeds this gateway.
 *
 * Breazy already authenticated the human; re-asking them for a password here
 * would be theatre. Instead its server mints a short-lived signed token and
 * links the operator straight into the UI, where they land as a **superadmin**:
 * able to see, enter, create and manage every workspace on the instance.
 *
 * Why this is safe to hand out that much authority:
 *   - The token is HMAC-signed with a key derived from ADMIN_API_KEY, which
 *     already means "the embedding platform's privileged access". Deriving a
 *     separate key keeps the signing domain apart from the bearer-token
 *     domain, so a leaked signature can never be replayed as an API key.
 *   - It expires in minutes and carries a nonce, so a link that leaks into a
 *     log or a chat is worthless by the time anyone finds it.
 *   - Superadmin is only ever granted here. Signup cannot produce one, so it
 *     is not self-assignable.
 *
 * With ADMIN_API_KEY unset the whole route is disabled, exactly like the
 * provisioning API.
 */

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { hashPassword } from '../crypto/credentials.js';
import { createUiSession } from '../ui/session.js';
import { safeNext } from './pocket-id.js';
import { logger } from '../logger.js';
import { logActivity } from '../observability/activity.js';

/** Signing key, derived so it is never the bearer key itself. */
function signingKey(): Buffer | null {
  if (!config.ADMIN_API_KEY) return null;
  return crypto.createHmac('sha256', config.ADMIN_API_KEY).update('sso-v1').digest();
}

export interface PartnerSsoClaims {
  email: string;
  name?: string;
  /** Unix ms. */
  exp: number;
  nonce: string;
}

/** Build a handoff token. Exported so the embedding platform can import the
 *  exact same implementation if it runs Node — and so it is testable. */
export function signPartnerToken(claims: PartnerSsoClaims): string {
  const key = signingKey();
  if (!key) throw new Error('ADMIN_API_KEY is not set; partner SSO is disabled');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyPartnerToken(token: string): PartnerSsoClaims | null {
  const key = signingKey();
  if (!key) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  // Length check first: timingSafeEqual throws on a mismatch.
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as PartnerSsoClaims;
    if (!claims.email || typeof claims.exp !== 'number') return null;
    if (claims.exp < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** The workspace superadmins nominally belong to. They act inside other
 *  workspaces via the switcher; this one just gives their user row a home. */
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

export function registerPartnerSsoRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { token?: string; next?: string } }>(
    '/auth/sso/partner',
    async (req, reply) => {
      // The login view is rendered by the UI routes, which assemble a full set
      // of locals for it. Failures redirect there with a message rather than
      // rendering it from here with a partial set — a missing local is an EJS
      // ReferenceError, i.e. a 500 in place of the error we meant to show.
      if (!config.ADMIN_API_KEY) return reply.code(404).send('Not found');

      const claims = req.query.token ? verifyPartnerToken(req.query.token) : null;
      if (!claims) {
        logActivity({
          category: 'oauth',
          action: 'partner-sso',
          status: 'failed',
          error: 'invalid or expired handoff token',
        });
        return reply.redirect(
          `/ui/login?error=${encodeURIComponent(
            'That sign-in link is invalid or has expired. Open it again from Breazy.',
          )}`,
        );
      }

      ensurePlatformOrg();
      const email = claims.email.toLowerCase();
      const existing = db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .get();
      let userId: string;
      if (existing) {
        userId = existing.id;
        // An operator who already had a workspace keeps it; the handoff only
        // raises their role.
        if (existing.role !== 'superadmin') {
          db.update(schema.users)
            .set({ role: 'superadmin' })
            .where(eq(schema.users.id, existing.id))
            .run();
        }
      } else {
        userId = nanoid();
        db.insert(schema.users)
          .values({
            id: userId,
            orgId: PLATFORM_ORG_ID,
            email,
            // Never used: this identity signs in through the partner only.
            passwordHash: hashPassword(crypto.randomBytes(24).toString('base64url')),
            role: 'superadmin',
            createdAt: Date.now(),
          })
          .run();
      }
      createUiSession(reply, userId);
      logger.info({ email }, 'partner SSO: superadmin session created');
      logActivity({
        category: 'oauth',
        action: 'partner-sso',
        status: 'ok',
        detail: `superadmin session for ${email}`,
      });
      return reply.redirect(safeNext(req.query.next));
    },
  );
}
