import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  buildAuthUrl,
  exchangeCode,
  fetchUserProfile,
  type ProviderName,
} from '../providers/oauth.js';
import { providerFor } from '../providers/index.js';
import { saveTokens } from './tokens.js';
import { logger } from '../logger.js';
import { currentSession, hasValidUiSession } from '../ui/session.js';
import { verifyConnectToken } from './connect-links.js';
import { assertCanAddAccount, QuotaError } from '../tenancy/orgs.js';

const STATE_COOKIE = 'ep_oauth_state';

function isProviderName(v: string): v is ProviderName {
  return v === 'google' || v === 'microsoft';
}

export function registerOauthRoutes(app: FastifyInstance) {
  app.get<{ Params: { provider: string }; Querystring: { token?: string } }>(
    '/auth/:provider/start',
    async (req, reply) => {
    const { provider } = req.params;
    if (!isProviderName(provider)) return reply.code(404).send({ error: 'Unknown provider' });
    // Either an admin UI session or a signed connect-link token opens the flow;
    // both resolve to the org the new account will belong to.
    const tokenOrg = req.query.token ? verifyConnectToken(provider, req.query.token) : null;
    const sessionOrg = tokenOrg ? null : currentSession(req)?.org.id ?? null;
    const orgId = tokenOrg ?? sessionOrg;
    if (!orgId) return reply.redirect('/ui/login');
    try {
      assertCanAddAccount(orgId);
    } catch (err) {
      if (err instanceof QuotaError) {
        return reply.redirect(`/ui?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    // Carry org through the OAuth round-trip inside the signed state cookie
    const state = `${nanoid(32)}|${orgId}`;
    reply.setCookie(STATE_COOKIE, state, {
      path: '/auth',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 600,
      signed: true,
    });
    return reply.redirect(buildAuthUrl(provider, state));
    },
  );

  app.get<{
    Params: { provider: string };
    Querystring: { code?: string; state?: string; error?: string; error_description?: string };
  }>('/auth/:provider/callback', async (req, reply) => {
    const { provider } = req.params;
    if (!isProviderName(provider)) return reply.code(404).send({ error: 'Unknown provider' });

    // Link-based connects (no admin session) get a standalone result page
    // instead of bouncing through the admin login screen.
    const finish = (opts: { email?: string; errorMessage?: string }) => {
      if (hasValidUiSession(req)) {
        return opts.errorMessage
          ? reply.redirect(`/ui?error=${encodeURIComponent(opts.errorMessage)}`)
          : reply.redirect('/ui');
      }
      return reply.view('connected.ejs', {
        page: 'login',
        error: opts.errorMessage ?? null,
        email: opts.email ?? null,
      });
    };

    const { code, state, error, error_description } = req.query;
    if (error) {
      return finish({ errorMessage: error_description ?? error });
    }

    const cookie = req.cookies[STATE_COOKIE];
    const unsigned = cookie ? req.unsignCookie(cookie) : { valid: false as const, value: null };
    reply.clearCookie(STATE_COOKIE, { path: '/auth' });
    if (!code || !state || !unsigned.valid || unsigned.value !== state) {
      return reply.code(400).send({ error: 'Invalid OAuth state' });
    }
    const orgId = state.split('|')[1];
    if (!orgId) return reply.code(400).send({ error: 'Invalid OAuth state' });

    try {
      const tokens = await exchangeCode(provider, code);
      const profile = await fetchUserProfile(provider, tokens.accessToken);
      const now = Date.now();

      const existing = db
        .select()
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.provider, provider),
            eq(schema.accounts.email, profile.email),
          ),
        )
        .get();

      let accountId: string;
      if (existing && existing.orgId !== orgId) {
        return finish({
          errorMessage: `${profile.email} is already connected to a different workspace`,
        });
      }
      if (existing) {
        accountId = existing.id;
        db.update(schema.accounts)
          .set({
            displayName: profile.displayName,
            status: 'active',
            lastError: null,
            updatedAt: now,
          })
          .where(eq(schema.accounts.id, accountId))
          .run();
      } else {
        accountId = nanoid();
        db.insert(schema.accounts)
          .values({
            id: accountId,
            orgId,
            provider,
            email: profile.email,
            displayName: profile.displayName,
            status: 'active',
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
      saveTokens(accountId, tokens);

      // Anchor the inbound-poll cursor at "now" (best-effort; poller re-anchors on demand)
      try {
        const cursor = await providerFor(provider).initCursor(accountId);
        db.insert(schema.syncState)
          .values({ accountId, cursor, lastPolledAt: null, lastError: null })
          .onConflictDoUpdate({
            target: schema.syncState.accountId,
            set: { cursor, lastError: null },
          })
          .run();
      } catch (err) {
        logger.warn({ accountId, err: String(err) }, 'failed to anchor sync cursor');
      }

      logger.info({ provider, email: profile.email, accountId }, 'account connected');
      return finish({ email: profile.email });
    } catch (err) {
      logger.error({ provider, err: String(err) }, 'oauth callback failed');
      return finish({ errorMessage: String(err) });
    }
  });
}
