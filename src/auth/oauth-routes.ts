import type { FastifyInstance, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import {
  buildAuthUrl,
  exchangeCode,
  fetchUserProfile,
  missingScopes,
  type ProviderName,
} from '../providers/oauth.js';
import { providerFor } from '../providers/index.js';
import { hasRefreshToken, saveTokens } from './tokens.js';
import { logger } from '../logger.js';
import { currentSession, hasValidUiSession } from '../ui/session.js';
import {
  verifyConnectToken,
  createOauthState,
  verifyOauthState,
  type TokenFailure,
} from './connect-links.js';
import { describeOutcome, isOutcomeCode, type OutcomeCode } from './connect-outcomes.js';
import { assertCanAddAccount, countAccounts, getOrg, planLimits, QuotaError } from '../tenancy/orgs.js';
import { logActivity } from '../observability/activity.js';

function isProviderName(v: string): v is ProviderName {
  return v === 'google' || v === 'microsoft';
}

function providerEnabled(provider: ProviderName): boolean {
  return provider === 'google' ? config.googleEnabled : config.microsoftEnabled;
}

const PROVIDER_LABEL: Record<ProviderName, string> = {
  google: 'Google / Gmail',
  microsoft: 'Microsoft 365 / Outlook',
};

const TOKEN_FAILURE_OUTCOME: Record<TokenFailure, OutcomeCode> = {
  malformed: 'link_malformed',
  expired: 'link_expired',
  revoked: 'link_revoked',
  wrong_provider: 'wrong_provider',
};

// The connect page is the durable, shareable surface: one URL, opened once per
// mailbox, that always shows where the workspace stands and what to do next.
function renderConnectPage(
  reply: FastifyReply,
  opts: {
    orgId: string | null;
    token: string | null;
    outcomeCode?: OutcomeCode | null;
    outcomeContext?: { email?: string | null; detail?: string | null; provider?: string | null };
  },
) {
  const outcome = opts.outcomeCode
    ? describeOutcome(opts.outcomeCode, opts.outcomeContext ?? {})
    : null;

  // A dead link has no workspace to describe — show the outcome alone.
  if (!opts.orgId || !opts.token) {
    return reply.code(outcome && outcome.tone === 'error' ? 400 : 200).view('connect.ejs', {
      page: 'login',
      error: null,
      outcome,
      workspace: null,
      accounts: [],
      usage: null,
      providers: [],
      token: null,
    });
  }

  const org = getOrg(opts.orgId);
  const accounts = org
    ? db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.orgId, org.id))
        .orderBy(desc(schema.accounts.createdAt))
        .all()
    : [];
  const limits = org ? planLimits(org) : null;
  const used = org ? countAccounts(org.id) : 0;
  const providers = (['google', 'microsoft'] as ProviderName[])
    .filter(providerEnabled)
    .map((p) => ({
      name: p,
      label: PROVIDER_LABEL[p],
      href: `/auth/${p}/start?token=${encodeURIComponent(opts.token!)}`,
    }));

  return reply.view('connect.ejs', {
    page: 'login',
    error: null,
    outcome,
    workspace: org?.name ?? null,
    accounts,
    usage: limits
      ? {
          used,
          max: Number.isFinite(limits.maxAccounts) ? limits.maxAccounts : null,
          full: used >= limits.maxAccounts,
        }
      : null,
    providers,
    token: opts.token,
  });
}

function logConnectFailure(orgId: string | undefined, code: OutcomeCode, detail: string) {
  logActivity({
    category: 'oauth',
    action: 'connect',
    status: 'failed',
    orgId,
    detail: `connect failed (${code})`,
    error: detail,
  });
}

export function registerOauthRoutes(app: FastifyInstance) {
  // Durable onboarding page. Same URL every time; nothing about it is consumed
  // by use, so it can be handed to a person or an automation and called once
  // per mailbox.
  app.get<{ Querystring: { token?: string; status?: string; email?: string; detail?: string } }>(
    '/connect',
    async (req, reply) => {
      const { token, status, email, detail } = req.query;
      if (!token) {
        return renderConnectPage(reply, {
          orgId: null,
          token: null,
          outcomeCode: 'link_malformed',
        });
      }
      const verified = verifyConnectToken(token);
      if (!verified.ok) {
        return renderConnectPage(reply, {
          orgId: null,
          token: null,
          outcomeCode: TOKEN_FAILURE_OUTCOME[verified.reason],
        });
      }
      const org = getOrg(verified.orgId);
      if (!org || org.status !== 'active') {
        return renderConnectPage(reply, {
          orgId: null,
          token: null,
          outcomeCode: 'suspended',
        });
      }
      return renderConnectPage(reply, {
        orgId: verified.orgId,
        token,
        outcomeCode: status && isOutcomeCode(status) ? status : null,
        // Query values are shown back to the reader — bound their length.
        outcomeContext: { email: email?.slice(0, 200), detail: detail?.slice(0, 300) },
      });
    },
  );

  app.get<{ Params: { provider: string }; Querystring: { token?: string } }>(
    '/auth/:provider/start',
    async (req, reply) => {
      const { provider } = req.params;
      if (!isProviderName(provider)) return reply.code(404).send({ error: 'Unknown provider' });

      // Either an admin UI session or a signed connect-link token opens the
      // flow; both resolve to the org the new account will belong to.
      const rawToken = req.query.token;
      const verified = rawToken ? verifyConnectToken(rawToken, provider) : null;
      if (verified && !verified.ok) {
        return renderConnectPage(reply, {
          orgId: null,
          token: null,
          outcomeCode: TOKEN_FAILURE_OUTCOME[verified.reason],
          outcomeContext: { provider: PROVIDER_LABEL[provider] },
        });
      }
      const orgId = verified?.ok ? verified.orgId : currentSession(req)?.org.id ?? null;
      if (!orgId) return reply.redirect('/ui/login');

      const linkFlow = Boolean(verified?.ok);
      // Hub tokens come back to the connect page after each mailbox so the
      // next one is one click away.
      const hubToken = verified?.ok && verified.scope === 'any' ? verified.token : null;
      const bail = (code: OutcomeCode, ctx?: { detail?: string }) => {
        logConnectFailure(orgId, code, ctx?.detail ?? code);
        if (hubToken) {
          return reply.redirect(hubResultUrl(hubToken, code, { detail: ctx?.detail }));
        }
        if (!linkFlow) {
          const message = describeOutcome(code, ctx).detail;
          return reply.redirect(`/ui?error=${encodeURIComponent(message)}`);
        }
        return renderConnectPage(reply, {
          orgId: null,
          token: null,
          outcomeCode: code,
          outcomeContext: { provider: PROVIDER_LABEL[provider], detail: ctx?.detail },
        });
      };

      if (!providerEnabled(provider)) return bail('provider_disabled');
      try {
        assertCanAddAccount(orgId);
      } catch (err) {
        if (err instanceof QuotaError) {
          const org = getOrg(orgId);
          return bail(org && org.status !== 'active' ? 'suspended' : 'quota', {
            detail: err.message,
          });
        }
        throw err;
      }
      return reply.redirect(buildAuthUrl(provider, createOauthState(provider, orgId, hubToken)));
    },
  );

  app.get<{
    Params: { provider: string };
    Querystring: { code?: string; state?: string; error?: string; error_description?: string };
  }>('/auth/:provider/callback', async (req, reply) => {
    const { provider } = req.params;
    if (!isProviderName(provider)) return reply.code(404).send({ error: 'Unknown provider' });

    const { code, state, error, error_description } = req.query;
    const verifiedState = state ? verifyOauthState(provider, state) : null;

    // Where the result is shown: the admin dashboard for logged-in admins, the
    // connect page for hub links, a standalone page for provider-only links.
    const finish = (
      outcomeCode: OutcomeCode,
      ctx: { email?: string | null; detail?: string | null } = {},
    ) => {
      const outcome = describeOutcome(outcomeCode, { ...ctx, provider });
      if (outcome.tone === 'error') {
        logConnectFailure(verifiedState?.orgId, outcomeCode, ctx.detail ?? outcome.detail);
      }
      // Where the flow started wins over who happens to be logged in, so an
      // admin testing their own connect link sees what the recipient sees.
      if (verifiedState?.hubToken) {
        return reply.redirect(
          hubResultUrl(verifiedState.hubToken, outcomeCode, {
            email: ctx.email,
            detail: ctx.detail,
          }),
        );
      }
      if (hasValidUiSession(req)) {
        return outcome.tone === 'error'
          ? reply.redirect(
              `/ui?error=${encodeURIComponent(`${outcome.detail} ${outcome.fix ?? ''}`.trim())}`,
            )
          : reply.redirect('/ui');
      }
      return renderConnectPage(reply, {
        orgId: null,
        token: null,
        outcomeCode,
        outcomeContext: { ...ctx, provider: PROVIDER_LABEL[provider] },
      });
    };

    if (error) {
      const denied = error === 'access_denied' || error === 'consent_required';
      return finish(denied ? 'denied' : 'provider_error', {
        detail: error_description ?? error,
      });
    }
    if (!code || !verifiedState) return finish('state');
    const orgId = verifiedState.orgId;

    try {
      const tokens = await exchangeCode(provider, code);

      // Reject partial grants before anything is written: a mailbox missing
      // send/modify looks connected but can never do its job.
      const missing = missingScopes(provider, tokens.scopes);
      if (missing.length) return finish('missing_scopes', { detail: missing.join(', ') });

      const profile = await fetchUserProfile(provider, tokens.accessToken);
      const now = Date.now();

      const existing = db
        .select()
        .from(schema.accounts)
        .where(
          and(eq(schema.accounts.provider, provider), eq(schema.accounts.email, profile.email)),
        )
        .get();

      if (existing && existing.orgId !== orgId) {
        return finish('other_workspace', { email: profile.email });
      }
      // Without a long-lived token the account would break within the hour.
      // An existing account may legitimately keep the one already on file.
      if (!tokens.refreshToken && !(existing && hasRefreshToken(existing.id))) {
        return finish('no_refresh_token', { email: profile.email });
      }
      if (!existing) {
        // Re-check at the point of insert: several link flows can be in the air
        // at once, so the check at /start is not enough to hold the plan limit.
        try {
          assertCanAddAccount(orgId);
        } catch (err) {
          if (err instanceof QuotaError) {
            return finish('quota', { email: profile.email, detail: err.message });
          }
          throw err;
        }
      }

      let accountId: string;
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
      logActivity({
        category: 'oauth',
        action: 'connect',
        status: 'ok',
        accountId,
        detail: `${provider} account ${existing ? 're-authorized' : 'connected'}`,
      });
      return finish(existing ? 'reconnected' : 'connected', { email: profile.email });
    } catch (err) {
      logger.error({ provider, err: String(err) }, 'oauth callback failed');
      return finish('provider_error', { detail: String(err) });
    }
  });
}

function hubResultUrl(
  hubToken: string,
  status: OutcomeCode,
  ctx: { email?: string | null; detail?: string | null } = {},
): string {
  const url = new URL(`${config.BASE_URL.replace(/\/$/, '')}/connect`);
  url.searchParams.set('token', hubToken);
  url.searchParams.set('status', status);
  if (ctx.email) url.searchParams.set('email', ctx.email);
  if (ctx.detail) url.searchParams.set('detail', ctx.detail.slice(0, 300));
  return url.toString();
}
