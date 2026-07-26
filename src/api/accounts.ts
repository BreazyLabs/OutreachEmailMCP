import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { deleteAccountSpoolFiles } from '../queue/sendQueue.js';
import { buildAccountsCsv } from '../export/accounts-csv.js';
import {
  createConnectHubLink,
  createConnectLink,
  revokeConnectLinks,
} from '../auth/connect-links.js';
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
  // hand it to a user or automation to add accounts. The link is reusable:
  // opening it once per mailbox is the intended flow, and nothing about it is
  // consumed by use. Omit `provider` for a hub link that offers every
  // configured provider and shows what is already connected.
  app.post('/connect-links', async (req, reply) => {
    if (!requireScope(req, reply, 'accounts')) return;
    const body = z
      .object({
        provider: z.enum(['google', 'microsoft']).optional(),
        // 0 = never expires (revoke with DELETE /connect-links instead)
        expiresInHours: z.coerce.number().min(0).max(24 * 365).optional(),
      })
      .parse(req.body ?? {});
    if (body.provider) {
      const enabled = body.provider === 'google' ? config.googleEnabled : config.microsoftEnabled;
      if (!enabled) {
        return reply.code(409).send({ error: `${body.provider} OAuth is not configured` });
      }
    }
    const hours = body.expiresInHours ?? (body.provider ? config.CONNECT_LINK_TTL_HOURS : 0);
    return {
      provider: body.provider ?? 'any',
      url: body.provider
        ? createConnectLink(body.provider, orgOf(req), hours)
        : createConnectHubLink(orgOf(req), hours),
      reusable: true,
      expiresAt: hours > 0 ? Date.now() + hours * 3600_000 : null,
    };
  });

  // Revoke every connect link issued for this workspace so far.
  app.delete('/connect-links', async (req, reply) => {
    if (!requireScope(req, reply, 'accounts')) return;
    revokeConnectLinks(orgOf(req));
    return { revoked: true, url: createConnectHubLink(orgOf(req)) };
  });

  app.get<{ Params: { accountId: string } }>('/accounts/:accountId', async (req, reply) => {
    if (!requireScope(req, reply, 'read')) return;
    const account = loadAccount(req.params.accountId, req);
    if (!account) return reply.code(404).send({ error: 'Unknown account' });
    return publicAccount(account);
  });

  // Transaction log: every operation with pass/fail, filterable.
  app.get<{
    Querystring: { status?: string; category?: string; accountId?: string; limit?: string };
  }>('/activity', async (req, reply) => {
    if (!requireScope(req, reply, 'read')) return;
    const conditions = [eq(schema.activityLog.orgId, orgOf(req))];
    if (req.query.status === 'ok' || req.query.status === 'failed') {
      conditions.push(eq(schema.activityLog.status, req.query.status));
    }
    if (req.query.category) conditions.push(eq(schema.activityLog.category, req.query.category));
    if (req.query.accountId) conditions.push(eq(schema.activityLog.accountId, req.query.accountId));
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    return db
      .select()
      .from(schema.activityLog)
      .where(and(...conditions))
      .orderBy(desc(schema.activityLog.createdAt))
      .limit(limit)
      .all();
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
