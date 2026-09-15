import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { deleteAccountSpoolFiles } from '../queue/sendQueue.js';
import { purgeAccountTasks } from '../warmup/tasks.js';
import { buildAccountsCsv } from '../export/accounts-csv.js';
import {
  createConnectHubLink,
  createConnectLink,
  revokeConnectLinks,
} from '../auth/connect-links.js';
import { config } from '../config.js';
import { loadAccount, orgOf, requireScope } from './plugin.js';
import { parseTags, setAccountTags, MAX_TAG_LENGTH, MAX_TAGS_PER_ACCOUNT } from '../accounts/tags.js';
import { namesFor, setAccountNames, refreshAccountProfiles } from '../accounts/profile.js';

const idList = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

const accountTagsSchema = z
  .object({
    tags: z.array(z.string().max(MAX_TAG_LENGTH)).max(MAX_TAGS_PER_ACCOUNT).optional(),
    firstName: z.string().max(60).nullable().optional(),
    lastName: z.string().max(60).nullable().optional(),
    displayName: z.string().max(120).nullable().optional(),
  })
  .strict();

export function publicAccount(a: typeof schema.accounts.$inferSelect) {
  return {
    id: a.id,
    provider: a.provider,
    email: a.email,
    displayName: a.displayName,
    status: a.status,
    lastError: a.lastError,
    tags: parseTags(a.tagsJson),
    firstName: namesFor(a).firstName || null,
    lastName: namesFor(a).lastName || null,
    /** Whether the names are stored (provider or hand-set) or guessed from the address. */
    namesSource: namesFor(a).source,
    createdAt: a.createdAt,
  };
}

export function registerAccountRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { tag?: string } }>('/accounts', async (req, reply) => {
    if (!requireScope(req, reply, 'read')) return;
    const rows = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.orgId, orgOf(req)))
      .orderBy(desc(schema.accounts.createdAt))
      .all();
    const tag = req.query.tag?.trim().toLowerCase();
    const list = tag
      ? rows.filter((a) => parseTags(a.tagsJson).some((t) => t.toLowerCase() === tag))
      : rows;
    return list.map(publicAccount);
  });

  // Tags are the one thing about a mailbox a caller edits directly: the rest
  // is owned by the provider connection.
  app.patch<{ Params: { accountId: string } }>('/accounts/:accountId', async (req, reply) => {
    if (!requireScope(req, reply, 'accounts')) return;
    const account = loadAccount(req.params.accountId, req);
    if (!account) return reply.code(404).send({ error: 'Unknown account' });
    const input = accountTagsSchema.parse(req.body ?? {});
    if (input.tags) setAccountTags(account.id, input.tags);
    if (input.firstName !== undefined || input.lastName !== undefined || input.displayName !== undefined) {
      setAccountNames(account.id, { firstName: input.firstName, lastName: input.lastName, displayName: input.displayName });
    }
    const fresh = db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    return publicAccount(fresh ?? account);
  });

  // CSV with per-account SMTP settings for this proxy (auto-creates missing
  // credentials) — directly importable into sending tools.
  app.get<{ Querystring: { format?: string; tag?: string; accountIds?: string } }>('/accounts/export.csv', async (req, reply) => {
    if (!requireScope(req, reply, 'export')) return;
    const format = req.query.format ?? 'generic';
    return reply
      .type('text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="outreachemailmcp-${format}-accounts.csv"`,
      )
      .send(buildAccountsCsv(orgOf(req), format, { tag: req.query.tag, accountIds: idList(req.query.accountIds) }));
  });

  // Pull the owner's name from the provider for some or all mailboxes.
  app.post<{ Body: { accountIds?: string[] } }>('/accounts/refresh-profile', async (req, reply) => {
    if (!requireScope(req, reply, 'accounts')) return;
    const ids = Array.isArray(req.body?.accountIds) ? req.body.accountIds.map(String) : undefined;
    return { results: await refreshAccountProfiles(orgOf(req), ids) };
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
    purgeAccountTasks(account.id);
    db.delete(schema.accounts).where(eq(schema.accounts.id, account.id)).run();
    return { deleted: account.id };
  });
}
