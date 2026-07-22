import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, gt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { generateApiKey, randomBase62 } from '../crypto/credentials.js';
import { decryptSecret, encryptSecret } from '../crypto/secrets.js';
import { isPrivateWebhookTarget } from '../inbound/webhooks.js';
import { deleteAccountSpoolFiles } from '../queue/sendQueue.js';
import { createSmtpCredential, smtpAdvertisedHost } from '../smtp/credentials.js';
import { buildAccountsCsv } from '../export/accounts-csv.js';
import { createConnectLink } from '../auth/connect-links.js';
import { publicJob } from '../api/send-log.js';
import { providerFor } from '../providers/index.js';
import { ALL_SCOPES } from '../api/plugin.js';
import { SEQUENCER_LABELS } from '../export/accounts-csv.js';
import { ssoEnabled } from '../auth/sso.js';
import {
  createOrgWithOwner,
  countAccounts,
  countSendsLast24h,
  planLimits,
} from '../tenancy/orgs.js';
import {
  authenticateUser,
  createUiSession,
  destroyUiSession,
  requireUiSession,
  hasValidUiSession,
  csrfTokenFor,
  verifyCsrf,
  type SessionContext,
} from './session.js';

type Req = FastifyRequest;
type Rep = FastifyReply;

function guard(req: Req, reply: Rep): SessionContext | null {
  return requireUiSession(req, reply);
}

function guardPost(req: Req, reply: Rep): SessionContext | null {
  const session = requireUiSession(req, reply);
  if (!session) return null;
  if (!verifyCsrf(req)) {
    reply.code(403).send('Invalid CSRF token');
    return null;
  }
  return session;
}

function baseLocals(req: Req, session?: SessionContext | null) {
  return {
    csrf: csrfTokenFor(req),
    googleEnabled: config.googleEnabled,
    microsoftEnabled: config.microsoftEnabled,
    saasMode: config.SAAS_MODE,
    stripeEnabled: config.stripeEnabled,
    ssoEnabled: ssoEnabled(),
    orgName: session?.org.name ?? null,
    baseUrl: config.BASE_URL.replace(/\/$/, ''),
    error: (req.query as { error?: string }).error ?? null,
    notice: null as string | null,
  };
}

export function registerUiRoutes(app: FastifyInstance) {
  // Public landing page; logged-in users go straight to the dashboard
  app.get('/', async (req, reply) => {
    if (hasValidUiSession(req)) return reply.redirect('/ui');
    return reply.view('landing.ejs', { saasMode: config.SAAS_MODE });
  });

  app.get('/ui/login', async (req, reply) => {
    if (hasValidUiSession(req)) return reply.redirect('/ui');
    return reply.view('login.ejs', { ...baseLocals(req), page: 'login' });
  });

  app.post<{ Body: { email?: string; password?: string } }>('/ui/login', async (req, reply) => {
    const user = authenticateUser(req.body.email ?? null, req.body.password ?? '');
    if (!user) {
      return reply.view('login.ejs', {
        ...baseLocals(req),
        page: 'login',
        error: config.SAAS_MODE ? 'Wrong email or password' : 'Wrong password',
      });
    }
    createUiSession(reply, user.id);
    return reply.redirect('/ui');
  });

  app.get('/ui/signup', async (req, reply) => {
    if (!config.SAAS_MODE) return reply.redirect('/ui/login');
    if (hasValidUiSession(req)) return reply.redirect('/ui');
    return reply.view('signup.ejs', { ...baseLocals(req), page: 'login' });
  });

  app.post<{ Body: { email?: string; password?: string; org?: string } }>(
    '/ui/signup',
    async (req, reply) => {
      if (!config.SAAS_MODE) return reply.code(404).send('Signup is disabled');
      const email = (req.body.email ?? '').trim().toLowerCase();
      const password = req.body.password ?? '';
      const fail = (error: string) =>
        reply.view('signup.ejs', { ...baseLocals(req), page: 'login', error });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Enter a valid email address');
      if (password.length < 10) return fail('Password must be at least 10 characters');
      const existing = db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .get();
      if (existing) return fail('An account with this email already exists');
      const orgName = (req.body.org ?? '').trim() || email.split('@')[1] || 'My workspace';
      const { userId } = createOrgWithOwner({ orgName, email, password });
      createUiSession(reply, userId);
      return reply.redirect('/ui');
    },
  );

  app.post('/ui/logout', async (req, reply) => {
    destroyUiSession(req, reply);
    return reply.redirect('/ui/login');
  });

  app.get('/ui', async (req, reply) => {
    const session = guard(req, reply);
    if (!session) return;
    const orgId = session.org.id;
    const accounts = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.orgId, orgId))
      .orderBy(desc(schema.accounts.createdAt))
      .all();
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    const recentJobs = db
      .select()
      .from(schema.sendJobs)
      .orderBy(desc(schema.sendJobs.createdAt))
      .limit(50)
      .all()
      .filter((j) => accountById.has(j.accountId))
      .slice(0, 10);
    return reply.view('dashboard.ejs', {
      ...baseLocals(req, session),
      page: 'dashboard',
      accounts,
      connectLinks: {
        google: config.googleEnabled ? createConnectLink('google', orgId) : null,
        microsoft: config.microsoftEnabled ? createConnectLink('microsoft', orgId) : null,
      },
      recentJobs: recentJobs.map((j) => ({
        ...publicJob(j),
        accountEmail: accountById.get(j.accountId)?.email ?? j.accountId,
      })),
      sequencers: SEQUENCER_LABELS,
    });
  });

  app.get<{ Params: { accountId: string } }>('/ui/accounts/:accountId', async (req, reply) => {
    const session = guard(req, reply);
    if (!session) return;
    const account = db
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.id, req.params.accountId),
          eq(schema.accounts.orgId, session.org.id),
        ),
      )
      .get();
    if (!account) return reply.code(404).send('Unknown account');
    const credentials = db
      .select()
      .from(schema.smtpCredentials)
      .where(eq(schema.smtpCredentials.accountId, account.id))
      .orderBy(desc(schema.smtpCredentials.createdAt))
      .all();
    const jobs = db
      .select()
      .from(schema.sendJobs)
      .where(eq(schema.sendJobs.accountId, account.id))
      .orderBy(desc(schema.sendJobs.createdAt))
      .limit(25)
      .all();
    const sync = db
      .select()
      .from(schema.syncState)
      .where(eq(schema.syncState.accountId, account.id))
      .get();
    const tokenRow = db
      .select({ scopes: schema.oauthTokens.scopes })
      .from(schema.oauthTokens)
      .where(eq(schema.oauthTokens.accountId, account.id))
      .get();
    const warmupReady = providerFor(account.provider).supportsWrite(tokenRow?.scopes ?? '');
    return reply.view('account.ejs', {
      ...baseLocals(req, session),
      page: 'account',
      account,
      warmupReady,
      credentials: credentials.map((c) => {
        let password: string | null = null;
        try {
          password = decryptSecret(c.passwordEnc);
        } catch {
          // legacy/undecryptable row — shown without a password
        }
        return { ...c, password };
      }),
      jobs: jobs.map(publicJob),
      sync: sync ?? null,
      newCredential: null,
      smtpHost: smtpAdvertisedHost(),
      smtpPort: config.SMTP_PORT,
      imapPort: config.IMAP_PORT,
    });
  });

  app.post<{ Params: { accountId: string } }>(
    '/ui/accounts/:accountId/smtp-credentials',
    async (req, reply) => {
      const session = guardPost(req, reply);
      if (!session) return;
      const account = db
        .select()
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.id, req.params.accountId),
            eq(schema.accounts.orgId, session.org.id),
          ),
        )
        .get();
      if (!account) return reply.code(404).send('Unknown account');
      const { username, password } = createSmtpCredential(account);
      return reply.view('credential-created.ejs', {
        ...baseLocals(req, session),
        page: 'account',
        account,
        username,
        password,
        smtpHost: smtpAdvertisedHost(),
        smtpPort: config.SMTP_PORT,
        imapPort: config.IMAP_PORT,
      });
    },
  );

  // CSV of all accounts with their proxy SMTP settings (creates credentials
  // for accounts that lack one).
  app.get<{ Querystring: { format?: string } }>('/ui/accounts.csv', async (req, reply) => {
    const session = guard(req, reply);
    if (!session) return;
    const format = req.query.format ?? 'generic';
    return reply
      .type('text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="outreachemailmcp-${format}-accounts.csv"`,
      )
      .send(buildAccountsCsv(session.org.id, format));
  });

  app.post<{ Params: { credentialId: string } }>(
    '/ui/smtp-credentials/:credentialId/revoke',
    async (req, reply) => {
      const session = guardPost(req, reply);
      if (!session) return;
      const credential = db
        .select({ cred: schema.smtpCredentials, orgId: schema.accounts.orgId })
        .from(schema.smtpCredentials)
        .innerJoin(schema.accounts, eq(schema.accounts.id, schema.smtpCredentials.accountId))
        .where(eq(schema.smtpCredentials.id, req.params.credentialId))
        .get();
      if (!credential || credential.orgId !== session.org.id) {
        return reply.code(404).send('Unknown credential');
      }
      db.update(schema.smtpCredentials)
        .set({ revokedAt: Date.now() })
        .where(eq(schema.smtpCredentials.id, credential.cred.id))
        .run();
      return reply.redirect(`/ui/accounts/${credential.cred.accountId}`);
    },
  );

  app.post<{ Params: { accountId: string } }>(
    '/ui/accounts/:accountId/delete',
    async (req, reply) => {
      const session = guardPost(req, reply);
      if (!session) return;
      const account = db
        .select()
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.id, req.params.accountId),
            eq(schema.accounts.orgId, session.org.id),
          ),
        )
        .get();
      if (!account) return reply.code(404).send('Unknown account');
      deleteAccountSpoolFiles(account.id);
      db.delete(schema.accounts).where(eq(schema.accounts.id, account.id)).run();
      return reply.redirect('/ui');
    },
  );

  app.get('/ui/apikeys', async (req, reply) => {
    const session = guard(req, reply);
    if (!session) return;
    const keys = db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.orgId, session.org.id))
      .orderBy(desc(schema.apiKeys.createdAt))
      .all();
    return reply.view('apikeys.ejs', {
      ...baseLocals(req, session),
      page: 'apikeys',
      keys,
      newKey: null,
    });
  });

  app.post<{ Body: { name?: string; scopes?: string | string[] } }>('/ui/apikeys', async (req, reply) => {
    const session = guardPost(req, reply);
    if (!session) return;
    const name = (req.body.name ?? '').trim() || 'unnamed';
    const requested = (Array.isArray(req.body.scopes)
      ? req.body.scopes
      : req.body.scopes
        ? [req.body.scopes]
        : []
    ).filter((s) => (ALL_SCOPES as string[]).includes(s));
    // all scopes (or none selected) → wildcard
    const scopes =
      requested.length === 0 || requested.length === ALL_SCOPES.length ? ['*'] : requested;
    const { key, prefix, hash } = generateApiKey();
    db.insert(schema.apiKeys)
      .values({
        id: nanoid(),
        orgId: session.org.id,
        name,
        keyPrefix: prefix,
        keyHash: hash,
        scopes: JSON.stringify(scopes),
        createdAt: Date.now(),
      })
      .run();
    const keys = db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.orgId, session.org.id))
      .orderBy(desc(schema.apiKeys.createdAt))
      .all();
    return reply.view('apikeys.ejs', {
      ...baseLocals(req, session),
      page: 'apikeys',
      keys,
      newKey: { name, key },
    });
  });

  app.post<{ Params: { keyId: string } }>('/ui/apikeys/:keyId/revoke', async (req, reply) => {
    const session = guardPost(req, reply);
    if (!session) return;
    db.update(schema.apiKeys)
      .set({ revokedAt: Date.now() })
      .where(
        and(eq(schema.apiKeys.id, req.params.keyId), eq(schema.apiKeys.orgId, session.org.id)),
      )
      .run();
    return reply.redirect('/ui/apikeys');
  });

  app.get('/ui/webhooks', async (req, reply) => {
    const session = guard(req, reply);
    if (!session) return;
    const orgId = session.org.id;
    const hooks = db
      .select()
      .from(schema.webhooks)
      .where(eq(schema.webhooks.orgId, orgId))
      .orderBy(desc(schema.webhooks.createdAt))
      .all();
    const accounts = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.orgId, orgId))
      .all();
    const hookIds = new Set(hooks.map((h) => h.id));
    const deliveries = db
      .select()
      .from(schema.webhookDeliveries)
      .orderBy(desc(schema.webhookDeliveries.createdAt))
      .limit(200)
      .all()
      .filter((d) => hookIds.has(d.webhookId))
      .slice(0, 25);
    return reply.view('webhooks.ejs', {
      ...baseLocals(req, session),
      page: 'webhooks',
      hooks: hooks.map((w) => ({ ...w, secret: decryptSecret(w.secretEnc) })),
      accounts,
      deliveries,
    });
  });

  app.post<{ Body: { url?: string; accountId?: string } }>('/ui/webhooks', async (req, reply) => {
    const session = guardPost(req, reply);
    if (!session) return;
    const url = (req.body.url ?? '').trim();
    let error: string | null = null;
    if (!/^https?:\/\//.test(url)) {
      error = 'Webhook URL must start with http:// or https://';
    } else if (!config.WEBHOOKS_ALLOW_PRIVATE && (await isPrivateWebhookTarget(url))) {
      error = 'Target resolves to a private address (set WEBHOOKS_ALLOW_PRIVATE=true to allow)';
    }
    if (error) return reply.redirect(`/ui/webhooks?error=${encodeURIComponent(error)}`);
    db.insert(schema.webhooks)
      .values({
        id: nanoid(),
        orgId: session.org.id,
        accountId: req.body.accountId || null,
        url,
        secretEnc: encryptSecret(`whsec_${randomBase62(32)}`),
        events: JSON.stringify(['message.received']),
        active: 1,
        createdAt: Date.now(),
      })
      .run();
    return reply.redirect('/ui/webhooks');
  });

  app.post<{ Params: { webhookId: string } }>(
    '/ui/webhooks/:webhookId/delete',
    async (req, reply) => {
      const session = guardPost(req, reply);
      if (!session) return;
      db.delete(schema.webhooks)
        .where(
          and(
            eq(schema.webhooks.id, req.params.webhookId),
            eq(schema.webhooks.orgId, session.org.id),
          ),
        )
        .run();
      return reply.redirect('/ui/webhooks');
    },
  );

  app.get('/ui/sendlog', async (req, reply) => {
    const session = guard(req, reply);
    if (!session) return;
    const accounts = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.orgId, session.org.id))
      .all();
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    const jobs = db
      .select()
      .from(schema.sendJobs)
      .orderBy(desc(schema.sendJobs.createdAt))
      .limit(500)
      .all()
      .filter((j) => accountById.has(j.accountId))
      .slice(0, 100);
    return reply.view('sendlog.ejs', {
      ...baseLocals(req, session),
      page: 'sendlog',
      jobs: jobs.map((j) => ({
        ...publicJob(j),
        accountEmail: accountById.get(j.accountId)?.email ?? j.accountId,
      })),
    });
  });

  app.get<{ Querystring: { status?: string; category?: string } }>(
    '/ui/activity',
    async (req, reply) => {
      const session = guard(req, reply);
      if (!session) return;
      const conditions = [eq(schema.activityLog.orgId, session.org.id)];
      if (req.query.status === 'ok' || req.query.status === 'failed') {
        conditions.push(eq(schema.activityLog.status, req.query.status));
      }
      if (req.query.category) {
        conditions.push(eq(schema.activityLog.category, req.query.category));
      }
      const rows = db
        .select()
        .from(schema.activityLog)
        .where(and(...conditions))
        .orderBy(desc(schema.activityLog.createdAt))
        .limit(200)
        .all();
      const failedLast24h = db
        .select()
        .from(schema.activityLog)
        .where(
          and(
            eq(schema.activityLog.orgId, session.org.id),
            eq(schema.activityLog.status, 'failed'),
            gt(schema.activityLog.createdAt, Date.now() - 24 * 3600_000),
          ),
        )
        .all().length;
      return reply.view('activity.ejs', {
        ...baseLocals(req, session),
        page: 'activity',
        rows,
        failedLast24h,
        retentionDays: config.ACTIVITY_RETENTION_DAYS,
        filters: { status: req.query.status ?? '', category: req.query.category ?? '' },
      });
    },
  );

  app.get('/ui/billing', async (req, reply) => {
    const session = guard(req, reply);
    if (!session) return;
    if (!config.SAAS_MODE) return reply.redirect('/ui');
    const limits = planLimits(session.org);
    return reply.view('billing.ejs', {
      ...baseLocals(req, session),
      page: 'billing',
      org: session.org,
      usage: {
        accounts: countAccounts(session.org.id),
        maxAccounts: limits.maxAccounts,
        sends24h: countSendsLast24h(session.org.id),
        dailySends: limits.dailySends,
      },
    });
  });
}
