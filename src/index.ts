import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyView from '@fastify/view';
import ejs from 'ejs';
import { config } from './config.js';
import { logger } from './logger.js';
import { runMigrations } from './db/index.js';
import { seedTenancy } from './tenancy/orgs.js';
import { registerBillingRoutes } from './billing/stripe.js';
import { registerMcpRoutes } from './mcp/server.js';
import { registerSsoRoutes } from './auth/sso.js';
import { registerPartnerSsoRoutes } from './auth/partner-sso.js';
import { registerPocketIdRoutes } from './auth/pocket-id.js';
import { registerOauthRoutes } from './auth/oauth-routes.js';
import { startTokenRefreshSweep } from './auth/tokens.js';
import { startActivityPruner } from './observability/activity.js';
import { startHealthReporter } from './observability/healthcheck.js';
import { registerUiRoutes } from './ui/routes.js';
import { apiKeyAuth, registerApiErrorHandler } from './api/plugin.js';
import { registerAccountRoutes } from './api/accounts.js';
import { registerSendRoutes } from './api/messages-send.js';
import { registerReadRoutes } from './api/messages-read.js';
import { registerSendLogRoutes } from './api/send-log.js';
import { registerWebhookRoutes } from './api/webhooks.js';
import { registerStatsRoutes } from './api/stats.js';
import { registerProvisioningRoutes } from './api/provisioning.js';
import { startSendWorker } from './queue/worker.js';
import { startSmtpServer } from './smtp/server.js';
import { startImapServer } from './imap/server.js';
import { startInboundPoller } from './inbound/poller.js';
import { startWebhookWorker } from './inbound/webhooks.js';
import { startWarmupEngine } from './warmup/index.js';
import { registerWarmupRoutes } from './warmup/api.js';
import { startLeaderLoop, INSTANCE_ID, isLeader, currentHolder } from './cluster/lease.js';
import { startOrderSync } from './domains/orders-worker.js';
import { imapConnectionCount, destroyImapConnections } from './imap/server.js';
import { sqlite } from './db/index.js';

async function main() {
  runMigrations();
  seedTenancy();

  // Cast: pino's Logger generic doesn't unify with FastifyBaseLogger across versions
  const app = Fastify({
    loggerInstance: logger.child({ component: 'http' }) as never,
    disableRequestLogging: true,
    bodyLimit: config.SMTP_MAX_SIZE,
  }) as unknown as FastifyInstance;

  await app.register(fastifyCookie, {
    secret: crypto.createHmac('sha256', config.masterKey).update('cookie-secret').digest('hex'),
  });
  await app.register(fastifyFormbody);
  await app.register(fastifyView, {
    engine: { ejs },
    root: path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui/views'),
  });

  registerApiErrorHandler(app);

  // Deep health: the database must answer, and a draining instance says so
  // with a 503 so the router stops handing it new connections.
  let draining = false;
  app.get('/healthz', async (_req, reply) => {
    let db = false;
    try {
      db = sqlite.prepare('SELECT 1 AS ok').get() !== undefined;
    } catch {
      db = false;
    }
    const body = {
      ok: db && !draining,
      instance: INSTANCE_ID,
      role: isLeader() ? 'leader' : 'follower',
      leader: currentHolder()?.holder ?? null,
      draining,
    };
    return reply.code(body.ok ? 200 : 503).send(body);
  });

  registerOauthRoutes(app);
  registerUiRoutes(app);
  registerBillingRoutes(app);
  registerMcpRoutes(app);
  registerSsoRoutes(app);
  registerPartnerSsoRoutes(app);
  registerPocketIdRoutes(app);

  await app.register(
    async (api) => {
      api.addHook('preHandler', apiKeyAuth);
      registerAccountRoutes(api);
      registerSendRoutes(api);
      registerReadRoutes(api);
      registerSendLogRoutes(api);
      registerWebhookRoutes(api);
      registerStatsRoutes(api);
      registerWarmupRoutes(api);
    },
    { prefix: '/api/v1' },
  );

  // Provisioning sits in its own scope: it authenticates with the instance's
  // ADMIN_API_KEY rather than an org-scoped key, so it must not inherit the
  // apiKeyAuth preHandler above.
  await app.register(
    async (admin) => {
      registerProvisioningRoutes(admin);
    },
    { prefix: '/api/v1' },
  );

  await app.listen({ port: config.HTTP_PORT, host: config.HTTP_BIND });
  logger.info(
    { url: `http://${config.HTTP_BIND}:${config.HTTP_PORT}/ui` },
    'http server listening',
  );

  // Edge role: every instance accepts mail and HTTP.
  const smtpServers = startSmtpServer();
  const imapServers = startImapServer();

  // Worker role: only the lease holder polls, sends, warms up and delivers
  // webhooks. Started and stopped as the lease comes and goes.
  let stopWorkers: (() => void) | null = null;
  const stopLeaderLoop = startLeaderLoop({
    onElected() {
      const stops = [
        startSendWorker(),
        startWebhookWorker(),
        startInboundPoller(),
        (() => {
          const t = startTokenRefreshSweep();
          return () => clearInterval(t);
        })(),
        startActivityPruner(),
        startHealthReporter(),
        startWarmupEngine(),
        startOrderSync(),
      ];
      stopWorkers = () => {
        for (const stop of stops.reverse()) {
          try {
            stop();
          } catch (err) {
            logger.warn({ err: String(err) }, 'stopping a worker failed');
          }
        }
        stopWorkers = null;
      };
      logger.info('workers started');
    },
    onLost() {
      stopWorkers?.();
      logger.info('workers stopped');
    },
  });

  // Graceful drain: stop accepting, let in-flight sessions finish, hand the
  // lease to a peer, then exit. Bounded so a stuck session cannot hold a
  // deploy hostage; the swarm stop grace period is 10 s.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    draining = true;
    logger.info({ signal, imapConnections: imapConnectionCount() }, 'draining');
    const deadline = Date.now() + 8_000;
    stopLeaderLoop(); // stops workers when we lead, and releases the lease
    for (const server of smtpServers) server.close(() => {});
    for (const server of imapServers) server.close(() => {});
    while (imapConnectionCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    destroyImapConnections();
    try {
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 2_000))]);
    } catch (err) {
      logger.warn({ err: String(err) }, 'http close failed');
    }
    logger.info('shutdown complete');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// A rejected promise nobody awaited must not take the whole edge down: log
// it and carry on. A thrown exception outside any handler leaves the process
// in an unknown state, so that one still exits (the swarm restarts us).
process.on('unhandledRejection', (reason) => {
  logger.error({ err: String(reason) }, 'unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err: String(err), stack: err.stack }, 'uncaught exception; exiting');
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
