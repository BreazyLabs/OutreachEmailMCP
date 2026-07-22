import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { deleteAccountSpoolFiles } from '../queue/sendQueue.js';
import { buildAccountsCsv } from '../export/accounts-csv.js';
import { createConnectLink } from '../auth/connect-links.js';
import { config } from '../config.js';
import { loadAccount, orgOf, requireScope } from './plugin.js';

export function publicAccount(a: typeof schema.accounts.$inferSelect) {
  return {
    id: a.id,
    provider: a.provider,
    email: a.email,
    displayName: a.displayName,
    status: a.status,
    lastError: a.lastError,
    createdAt: a.createdAt,
  };
}

export function registerAccountRoutes(app: FastifyInstance) {
  app.get('/accounts', async (req, reply) => {
    if (!requireScope(req, reply, 'read')) return;
    const rows = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.orgId, orgOf(req)))
      .orderBy(desc(schema.accounts.createdAt))
      .all();
    return rows.map(publicAccount);
  });

  // CSV with per-account SMTP settings for this proxy (auto-creates missing
  // credentials) — directly importable into sending tools.
  app.get<{ Querystring: { format?: string } }>('/accounts/export.csv', async (req, reply) => {
    if (!requireScope(req, reply, 'export')) return;
    const format = req.query.format ?? 'generic';
    return reply
      .type('text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="outreachemailmcp-${format}-accounts.csv"`,
      )
      .send(buildAccountsCsv(orgOf(req), format));
  });

  // Mint a signed OAuth connect link that works without an admin session —
  // hand it to a user or automation to add a new account.
  app.post('/connect-links', async (req, reply) => {
    if (!requireScope(req, reply, 'accounts')) return;
    const body = z
      .object({
        provider: z.enum(['google', 'microsoft']),
        expiresInHours: z.coerce.number().min(1).max(24 * 90).default(168),
      })
      .parse(req.body ?? {});
    const enabled = body.provider === 'google' ? config.googleEnabled : config.microsoftEnabled;
    if (!enabled) {
      return reply.code(409).send({ error: `${body.provider} OAuth is not configured` });
    }
    return {
      provider: body.provider,
      url: createConnectLink(body.provider, orgOf(req), body.expiresInHours),
      expiresAt: Date.now() + body.expiresInHours * 3600_000,
    };
  });

  app.get<{ Params: { accountId: string } }>('/accounts/:accountId', async (req, reply) => {
    if (!requireScope(req, reply, 'read')) return;
    const account = loadAccount(req.params.accountId, req);
    if (!account) return reply.code(404).send({ error: 'Unknown account' });
    return publicAccount(account);
  });

  app.delete<{ Params: { accountId: string } }>('/accounts/:accountId', async (req, reply) => {
    if (!requireScope(req, reply, 'accounts')) return;
    const account = loadAccount(req.params.accountId, req);
    if (!account) return reply.code(404).send({ error: 'Unknown account' });
    // Cascades wipe tokens, SMTP credentials, jobs, webhooks, sync state
    deleteAccountSpoolFiles(account.id);
    db.delete(schema.accounts).where(eq(schema.accounts.id, account.id)).run();
    return { deleted: account.id };
  });
}
