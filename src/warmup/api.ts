/**
 * REST surface for warmup. Reads need the `read` permission, changes need
 * `accounts`. Everything is scoped to the key's org.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { loadAccount, orgOf, requireScope } from '../api/plugin.js';
import { getOrg } from '../tenancy/orgs.js';
import { validatePatch, mergePatch, WARMUP_FIELDS, resolveWarmupSettings } from './settings.js';
import { orgWarmupOverview, accountWarmupDetail, recentWarmupMessages, dailySeries } from './stats.js';
import {
  enableWarmup,
  disableWarmup,
  pauseWarmup,
  resumeWarmup,
  setPersona,
  ensureWarmupRow,
  bulkWarmupAction,
  getWarmupAccount,
} from './state.js';
import { setOrgTag, invalidateTagCache } from './identity.js';
import { logActivity } from '../observability/activity.js';

const personaSchema = z
  .object({
    firstName: z.string().min(1).max(40).optional(),
    lastName: z.string().max(40).nullable().optional(),
    role: z.string().max(60).nullable().optional(),
    company: z.string().max(60).nullable().optional(),
    signOff: z.string().max(30).nullable().optional(),
  })
  .strict();

const accountPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    settings: z.record(z.unknown()).optional(),
    persona: personaSchema.optional(),
  })
  .strict();

const orgPatchSchema = z
  .object({
    defaults: z.record(z.unknown()).optional(),
    poolScope: z.enum(['instance', 'org']).optional(),
    filterTag: z.string().min(5).max(16).optional(),
    emitWebhooks: z.boolean().optional(),
    showInSendLog: z.boolean().optional(),
  })
  .strict();

const bulkSchema = z
  .object({
    accountIds: z.array(z.string()).min(1).max(500),
    action: z.enum(['enable', 'disable', 'pause', 'resume', 'settings', 'clear_overrides']).optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .strict();

export function applyAccountSettings(accountId: string, settings: Record<string, unknown>): void {
  const patch = validatePatch(settings);
  const row = ensureWarmupRow(accountId);
  db.update(schema.warmupAccounts)
    .set({ settingsJson: mergePatch(row.settingsJson, patch), updatedAt: Date.now() })
    .where(eq(schema.warmupAccounts.accountId, accountId))
    .run();
  logActivity({
    category: 'warmup',
    action: 'settings',
    status: 'ok',
    accountId,
    detail: Object.keys(patch).join(', ').slice(0, 400),
  });
}

export function clearAccountOverrides(accountId: string): void {
  ensureWarmupRow(accountId);
  db.update(schema.warmupAccounts)
    .set({ settingsJson: null, updatedAt: Date.now() })
    .where(eq(schema.warmupAccounts.accountId, accountId))
    .run();
}

export function applyOrgSettings(orgId: string, input: z.infer<typeof orgPatchSchema>): void {
  const org = getOrg(orgId);
  if (!org) throw new Error('Unknown organization');
  const patch: Partial<typeof org> = {};
  if (input.defaults) patch.warmupDefaultsJson = mergePatch(org.warmupDefaultsJson, validatePatch(input.defaults));
  if (input.poolScope) patch.warmupPoolScope = input.poolScope;
  if (input.emitWebhooks !== undefined) patch.warmupEmitWebhooks = input.emitWebhooks ? 1 : 0;
  if (input.showInSendLog !== undefined) patch.warmupShowInSendLog = input.showInSendLog ? 1 : 0;
  if (Object.keys(patch).length) db.update(schema.orgs).set(patch).where(eq(schema.orgs.id, orgId)).run();
  if (input.filterTag) setOrgTag(orgId, input.filterTag);
  invalidateTagCache();
  logActivity({
    category: 'warmup',
    action: 'org-settings',
    status: 'ok',
    orgId,
    detail: Object.keys(input).join(', '),
  });
}

export function runBulk(
  orgId: string,
  input: z.infer<typeof bulkSchema>,
): { results: { accountId: string; ok: boolean; error?: string }[] } {
  const owned = new Set(
    db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.orgId, orgId))
      .all()
      .map((r) => r.id),
  );
  const ids = input.accountIds.filter((id) => owned.has(id));
  const results: { accountId: string; ok: boolean; error?: string }[] = [];
  if (input.settings && Object.keys(input.settings).length) {
    const patch = validatePatch(input.settings);
    for (const id of ids) {
      try {
        const row = ensureWarmupRow(id);
        db.update(schema.warmupAccounts)
          .set({ settingsJson: mergePatch(row.settingsJson, patch), updatedAt: Date.now() })
          .where(eq(schema.warmupAccounts.accountId, id))
          .run();
        results.push({ accountId: id, ok: true });
      } catch (err) {
        results.push({ accountId: id, ok: false, error: String(err) });
      }
    }
    logActivity({
      category: 'warmup',
      action: 'bulk-settings',
      status: 'ok',
      orgId,
      detail: `${ids.length} mailbox(es): ${Object.keys(patch).join(', ')}`.slice(0, 400),
    });
  }
  if (input.action === 'clear_overrides') {
    for (const id of ids) {
      clearAccountOverrides(id);
      results.push({ accountId: id, ok: true });
    }
  } else if (input.action && input.action !== 'settings') {
    results.push(...bulkWarmupAction(ids, input.action));
  }
  return { results };
}

export function registerWarmupRoutes(app: FastifyInstance): void {
  app.get('/warmup', async (req, reply) => {
    if (!requireScope(req, reply, 'read')) return;
    const org = getOrg(orgOf(req));
    if (!org) return reply.code(404).send({ error: 'Unknown organization' });
    return orgWarmupOverview(org);
  });

  app.get('/warmup/fields', async (req, reply) => {
    if (!requireScope(req, reply, 'read')) return;
    return { fields: WARMUP_FIELDS };
  });

  app.get('/warmup/defaults', async (req, reply) => {
    if (!requireScope(req, reply, 'read')) return;
    const org = getOrg(orgOf(req));
    if (!org) return reply.code(404).send({ error: 'Unknown organization' });
    return {
      poolScope: org.warmupPoolScope,
      filterTag: org.warmupFilterTag,
      emitWebhooks: !!org.warmupEmitWebhooks,
      showInSendLog: !!org.warmupShowInSendLog,
      defaults: resolveWarmupSettings(org, null),
    };
  });

  app.put('/warmup/defaults', async (req, reply) => {
    if (!requireScope(req, reply, 'accounts')) return;
    const input = orgPatchSchema.parse(req.body ?? {});
    applyOrgSettings(orgOf(req), input);
    const org = getOrg(orgOf(req))!;
    return { ok: true, defaults: resolveWarmupSettings(org, null), filterTag: org.warmupFilterTag };
  });

  app.post('/warmup/bulk', async (req, reply) => {
    if (!requireScope(req, reply, 'accounts')) return;
    const input = bulkSchema.parse(req.body ?? {});
    return runBulk(orgOf(req), input);
  });

  app.get<{ Params: { accountId: string } }>('/accounts/:accountId/warmup', async (req, reply) => {
    if (!requireScope(req, reply, 'read')) return;
    const account = loadAccount(req.params.accountId, req);
    if (!account) return reply.code(404).send({ error: 'Unknown account' });
    const org = getOrg(account.orgId)!;
    return accountWarmupDetail(account, org);
  });

  app.put<{ Params: { accountId: string } }>('/accounts/:accountId/warmup', async (req, reply) => {
    if (!requireScope(req, reply, 'accounts')) return;
    const account = loadAccount(req.params.accountId, req);
    if (!account) return reply.code(404).send({ error: 'Unknown account' });
    const input = accountPatchSchema.parse(req.body ?? {});
    if (input.settings) applyAccountSettings(account.id, input.settings);
    if (input.persona) setPersona(account.id, input.persona);
    if (input.enabled === true) enableWarmup(account.id);
    if (input.enabled === false) disableWarmup(account.id);
    const org = getOrg(account.orgId)!;
    return accountWarmupDetail(account, org);
  });

  for (const action of ['start', 'pause', 'resume', 'stop'] as const) {
    app.post<{ Params: { accountId: string } }>(`/accounts/:accountId/warmup/${action}`, async (req, reply) => {
      if (!requireScope(req, reply, 'accounts')) return;
      const account = loadAccount(req.params.accountId, req);
      if (!account) return reply.code(404).send({ error: 'Unknown account' });
      const row =
        action === 'start'
          ? enableWarmup(account.id)
          : action === 'pause'
            ? pauseWarmup(account.id)
            : action === 'resume'
              ? resumeWarmup(account.id)
              : disableWarmup(account.id);
      return { accountId: account.id, enabled: !!row.enabled, state: row.state };
    });
  }

  app.get<{ Params: { accountId: string }; Querystring: Record<string, string> }>(
    '/accounts/:accountId/warmup/messages',
    async (req, reply) => {
      if (!requireScope(req, reply, 'read')) return;
      const account = loadAccount(req.params.accountId, req);
      if (!account) return reply.code(404).send({ error: 'Unknown account' });
      const limit = Math.min(Number(req.query.limit ?? '50') || 50, 500);
      return { messages: recentWarmupMessages(account.id, limit) };
    },
  );

  app.get<{ Params: { accountId: string }; Querystring: Record<string, string> }>(
    '/accounts/:accountId/warmup/daily',
    async (req, reply) => {
      if (!requireScope(req, reply, 'read')) return;
      const account = loadAccount(req.params.accountId, req);
      if (!account) return reply.code(404).send({ error: 'Unknown account' });
      const days = Math.min(Number(req.query.days ?? '30') || 30, 365);
      return { daily: dailySeries(account.id, days), state: getWarmupAccount(account.id)?.state ?? 'off' };
    },
  );
}

export { accountPatchSchema, orgPatchSchema, bulkSchema, personaSchema };
