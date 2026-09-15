import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, gt, ne } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { generateApiKey, randomBase62 } from '../crypto/credentials.js';
import { decryptSecret, encryptSecret } from '../crypto/secrets.js';
import { isPrivateWebhookTarget } from '../inbound/webhooks.js';
import { deleteAccountSpoolFiles } from '../queue/sendQueue.js';
import { purgeAccountTasks } from '../warmup/tasks.js';
import { createSmtpCredential, smtpAdvertisedHost } from '../smtp/credentials.js';
import { buildAccountsCsv } from '../export/accounts-csv.js';
import {
  createConnectHubLink,
  createConnectLink,
  revokeConnectLinks,
} from '../auth/connect-links.js';
import { publicJob } from '../api/send-log.js';
import { providerFor } from '../providers/index.js';
import { ALL_SCOPES } from '../api/plugin.js';
import { SEQUENCER_LABELS } from '../export/accounts-csv.js';
import { ssoEnabled } from '../auth/sso.js';
import { internalSsoAvailable } from '../auth/internal-network.js';
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
  setActingOrg,
  allOrgs,
} from './session.js';

type Rep = FastifyReply;
import { guard, guardPost, baseLocals } from './helpers.js';
import { registerWarmupUiRoutes } from './warmup-routes.js';
import { accountWarmupDetail } from '../warmup/stats.js';
import { healthOf, HEALTH_LABELS } from '../warmup/health.js';
import { placementChartSvg, CHART_LEGEND } from './charts.js';
import { mailboxesPageLocals } from './warmup-routes.js';
import { registerDomainsUiRoutes } from './domains-routes.js';
import { parseTags } from '../accounts/tags.js';
import { namesFor, setAccountNames, refreshAccountProfile } from '../accounts/profile.js';
import { WARMUP_FIELDS, resolveWarmupSettings } from '../warmup/settings.js';
import { config as appConfig } from '../config.js';

export function registerUiRoutes(app: FastifyInstance) {
  registerWarmupUiRoutes(app);
  registerDomainsUiRoutes(app);
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

  /** Enter another workspace. Superadmins only — everyone else is pinned
   *  to their own org and the control is not even rendered for them. */
  app.post<{ Body: { orgId?: string } }>('/ui/workspace/switch', async (req, reply) => {
    const session = guardPost(req, reply as Rep);
    if (!session) return;
    if (!session.isSuperuser) return reply.code(403).send('Not permitted');
    const orgId = req.body?.orgId ?? null;
    if (orgId && !db.select().from(schema.orgs).where(eq(schema.orgs.id, orgId)).get()) {
      return reply.redirect('/ui?error=Unknown+workspace');
    }
    setActingOrg(req, orgId);
    return reply.redirect('/ui');
  });

  app.get('/ui/workspace/new', async (req, reply) => {
    const session = guard(req, reply as Rep);
    if (!session) return;
    if (!session.isSuperuser) return reply.code(403).send('Not permitted');
    return reply.view('workspace-new.ejs', {
      ...baseLocals(req, session),
      page: 'dashboard',
      title: 'New workspace',
    });
  });

  app.post<{ Body: { name?: string } }>('/ui/workspace/new', async (req, reply) => {
    const session = guardPost(req, reply as Rep);
    if (!session) return;
    if (!session.isSuperuser) return reply.code(403).send('Not permitted');
    const name = (req.body?.name ?? '').trim();
    if (!name) return reply.redirect('/ui/workspace/new?error=Name+is+required');
    // Owner identity is synthetic: nobody signs into a superadmin-created
    // workspace directly — it is reached through the switcher or an API key.
    const { orgId } = createOrgWithOwner({
      orgName: name,
      email: `ws-${nanoid(10)}@platform.local`,
      password: randomBase62(32),
    });
    db.update(schema.orgs).set({ plan: 'pro' }).where(eq(schema.orgs.id, orgId)).run();
    setActingOrg(req, orgId);
    return reply.redirect('/ui?notice=Workspace+created');
  });

  app.get('/ui', async (req, reply) => {
    const session = guard(req, reply);
    if (!session) return;
    const orgId = session.org.id;
    return reply.view('mailboxes.ejs', {
      ...mailboxesPageLocals(req, session),
      connectLinks: {
        // Durable, reusable, revocable — the one to hand to whoever onboards
        // mailboxes. The per-provider links stay available for automations
        // that want to skip the chooser.
        hub: config.googleEnabled || config.microsoftEnabled ? createConnectHubLink(orgId) : null,
        google: config.googleEnabled ? createConnectLink('google', orgId) : null,
        microsoft: config.microsoftEnabled ? createConnectLink('microsoft', orgId) : null,
      },
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
      .where(
        session.org.warmupShowInSendLog
          ? eq(schema.sendJobs.accountId, account.id)
          : and(eq(schema.sendJobs.accountId, account.id), ne(schema.sendJobs.source, 'warmup')),
      )
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
    const warmup = accountWarmupDetail(account, session.org);
    return reply.view('account.ejs', {
      ...baseLocals(req, session),
      page: 'account',
      account,
      warmupReady,
      warmup,
      warmupHealth: healthOf(warmup.summary),
      accountTags: parseTags(account.tagsJson),
      accountNames: namesFor(account),
      healthLabels: HEALTH_LABELS,
      warmupChart: warmup.summary.enabled ? placementChartSvg(warmup.daily, 30) : null,
      chartLegend: CHART_LEGEND,
      warmupFields: WARMUP_FIELDS,
      orgResolved: resolveWarmupSettings(session.org, null).settings,
      engineEnabled: appConfig.WARMUP_ENABLED,
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

  // CSV of accounts with their proxy SMTP settings (creates credentials for
  // accounts that lack one). GET exports the workspace (optionally one tag);
  // POST exports the mailboxes selected on the Mailboxes page.
  const sendCsv = (reply: FastifyReply, orgId: string, format: string, filter: { accountIds?: string[]; tag?: string }) =>
    reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="outreachemailmcp-${format}-accounts.csv"`)
      .send(buildAccountsCsv(orgId, format, filter));
  app.get<{ Querystring: { format?: string; tag?: string } }>('/ui/accounts.csv', async (req, reply) => {
    const session = guard(req, reply);
    if (!session) return;
    return sendCsv(reply, session.org.id, req.query.format ?? 'generic', { tag: req.query.tag });
  });
  app.post<{ Body: { format?: string; accountIds?: string | string[] } }>('/ui/accounts.csv', async (req, reply) => {
    const session = guardPost(req, reply);
    if (!session) return;
    const raw = req.body?.accountIds;
    const accountIds = raw === undefined ? [] : Array.isArray(raw) ? raw.map(String) : [String(raw)];
    if (accountIds.length === 0) return reply.redirect('/ui?error=' + encodeURIComponent('Select at least one mailbox to export.'));
    return sendCsv(reply, session.org.id, String(req.body?.format ?? 'generic'), { accountIds });
  });

  // Names used by sequencer exports: set by hand, or fetched from the provider.
  app.post<{ Params: { accountId: string }; Body: { firstName?: string; lastName?: string; displayName?: string; refresh?: string } }>(
    '/ui/accounts/:accountId/profile',
    async (req, reply) => {
      const session = guardPost(req, reply);
      if (!session) return;
      const account = db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.id, req.params.accountId), eq(schema.accounts.orgId, session.org.id)))
        .get();
      if (!account) return reply.code(404).send('Unknown account');
      const back = `/ui/accounts/${account.id}`;
      if (req.body?.refresh) {
        try {
          const r = await refreshAccountProfile(account.id);
          return reply.redirect(
            `${back}?notice=` +
              encodeURIComponent(r ? `Provider name: ${[r.firstName, r.lastName].filter(Boolean).join(' ') || r.displayName}.` : 'The provider has no name on file for this mailbox; set one below.'),
          );
        } catch (err) {
          return reply.redirect(`${back}?error=` + encodeURIComponent(`Could not fetch the name: ${String(err).slice(0, 200)}`));
        }
      }
      setAccountNames(account.id, {
        firstName: String(req.body?.firstName ?? ''),
        lastName: String(req.body?.lastName ?? ''),
        displayName: String(req.body?.displayName ?? ''),
      });
      return reply.redirect(`${back}?notice=` + encodeURIComponent('Name saved.'));
    },
  );

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
      purgeAccountTasks(account.id);
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

  // Connect links are stateless signatures, so "revoke" means bumping the
  // workspace's link generation — every link handed out so far stops working
  // and the dashboard shows the new one.
  app.post('/ui/connect-links/revoke', async (req, reply) => {
    const session = guardPost(req, reply);
    if (!session) return;
    revokeConnectLinks(session.org.id);
    return reply.redirect('/ui?notice=Connect+links+revoked.+Share+the+new+link+below.');
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
      .limit(1000)
      .all()
      .filter((j) => accountById.has(j.accountId))
      .filter((j) => session.org.warmupShowInSendLog || j.source !== 'warmup')
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
