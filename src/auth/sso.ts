import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createOrgWithOwner } from '../tenancy/orgs.js';
import { createUiSession } from '../ui/session.js';
import { randomBase62 } from '../crypto/credentials.js';
import { AuthError, RetryableError } from '../providers/errors.js';

// "Sign in with Google" for the SaaS UI. Reuses the same Google OAuth client
// as mailbox connects but with identity scopes only — a separate redirect URI
// ({BASE_URL}/auth/sso/google/callback) must be registered in the console.
// Distinct from mailbox connect: this creates/logs in *users*, never touches mail.

const STATE_COOKIE = 'ep_sso_state';

function redirectUri(): string {
  return `${config.BASE_URL.replace(/\/$/, '')}/auth/sso/google/callback`;
}

export function ssoEnabled(): boolean {
  return config.SAAS_MODE && config.googleEnabled;
}

export function registerSsoRoutes(app: FastifyInstance): void {
  app.get('/auth/sso/google/start', async (req, reply) => {
    if (!ssoEnabled()) return reply.redirect('/ui/login');
    const state = nanoid(32);
    reply.setCookie(STATE_COOKIE, state, {
      path: '/auth',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 600,
      signed: true,
    });
    const params = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID!,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
    });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/sso/google/callback',
    async (req, reply) => {
      if (!ssoEnabled()) return reply.redirect('/ui/login');
      const cookie = req.cookies[STATE_COOKIE];
      const unsigned = cookie ? req.unsignCookie(cookie) : { valid: false as const, value: null };
      reply.clearCookie(STATE_COOKIE, { path: '/auth' });
      const { code, state, error } = req.query;
      if (error || !code || !state || !unsigned.valid || unsigned.value !== state) {
        return reply.redirect('/ui/login?error=' + encodeURIComponent('Google sign-in failed'));
      }
      try {
        const res = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.GOOGLE_CLIENT_ID!,
            client_secret: config.GOOGLE_CLIENT_SECRET!,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri(),
          }),
        });
        const tokens = (await res.json()) as { access_token?: string };
        if (!res.ok || !tokens.access_token) throw new AuthError('token exchange failed');
        const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (!infoRes.ok) throw new RetryableError('userinfo failed');
        const profile = (await infoRes.json()) as { email?: string; name?: string };
        const email = profile.email?.toLowerCase();
        if (!email) throw new AuthError('Google returned no email');

        let user = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
        if (!user) {
          // New user → new workspace; password is random (they log in via Google)
          const { userId } = createOrgWithOwner({
            orgName: profile.name || email.split('@')[1] || 'My workspace',
            email,
            password: randomBase62(32),
          });
          user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get()!;
          logger.info({ email }, 'workspace created via google sso');
        }
        createUiSession(reply, user.id);
        return reply.redirect('/ui');
      } catch (err) {
        logger.warn({ err: String(err) }, 'google sso failed');
        return reply.redirect('/ui/login?error=' + encodeURIComponent('Google sign-in failed'));
      }
    },
  );
}
