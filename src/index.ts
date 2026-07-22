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
import { registerOauthRoutes } from './auth/oauth-routes.js';
import { startTokenRefreshSweep } from './auth/tokens.js';
import { registerUiRoutes } from './ui/routes.js';
import { apiKeyAuth, registerApiErrorHandler } from './api/plugin.js';
import { registerAccountRoutes } from './api/accounts.js';
import { registerSendRoutes } from './api/messages-send.js';
import { registerReadRoutes } from './api/messages-read.js';
import { registerSendLogRoutes } from './api/send-log.js';
import { registerWebhookRoutes } from './api/webhooks.js';
import { startSendWorker } from './queue/worker.js';
import { startSmtpServer } from './smtp/server.js';
import { startImapServer } from './imap/server.js';
import { startInboundPoller } from './inbound/poller.js';
import { startWebhookWorker } from './inbound/webhooks.js';

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

  app.get('/healthz', async () => ({ ok: true }));

  registerOauthRoutes(app);
  registerUiRoutes(app);
  registerBillingRoutes(app);
  registerMcpRoutes(app);
  registerSsoRoutes(app);

  await app.register(
    async (api) => {
      api.addHook('preHandler', apiKeyAuth);
      registerAccountRoutes(api);
      registerSendRoutes(api);
      registerReadRoutes(api);
      registerSendLogRoutes(api);
      registerWebhookRoutes(api);
    },
    { prefix: '/api/v1' },
  );

  await app.listen({ port: config.HTTP_PORT, host: config.HTTP_BIND });
  logger.info(
    { url: `http://${config.HTTP_BIND}:${config.HTTP_PORT}/ui` },
    'http server listening',
  );

  const smtpServer = startSmtpServer();
  const imapServer = startImapServer();
  const stopSendWorker = startSendWorker();
  const stopWebhookWorker = startWebhookWorker();
  const stopPoller = startInboundPoller();
  startTokenRefreshSweep();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopSendWorker();
    stopWebhookWorker();
    stopPoller();
    smtpServer.close(() => {});
    imapServer.close(() => {});
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
