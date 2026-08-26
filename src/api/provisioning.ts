/**
 * Provisioning API — for a platform that puts this gateway underneath its own
 * product and needs to create workspaces without a human at a signup form.
 *
 * Everything here is authenticated with `ADMIN_API_KEY` (a single bootstrap
 * secret from the environment, not an org-scoped key) because these routes
 * deliberately cross tenant boundaries: they create workspaces and mint the
 * per-workspace API keys the caller then uses for ordinary scoped calls.
 * Without `ADMIN_API_KEY` set, the whole surface is disabled — a self-hosted
 * install that never provisions has no extra attack surface.
 *
 * The intended flow for an embedding product:
 *   1. POST /api/v1/admin/orgs           → workspace + unrestricted API key
 *   2. POST /api/v1/connect-links        → (with that key) a URL for the end
 *                                          user to attach Gmail/Outlook
 *   3. POST /api/v1/webhooks             → subscribe to delivery outcomes
 *   4. GET  /api/v1/stats                → pull rollups whenever needed
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, sqlite, schema } from '../db/index.js';
import { config } from '../config.js';
import { generateApiKey } from '../crypto/credentials.js';
import { createOrgWithOwner, getOrg, planLimits } from '../tenancy/orgs.js';
import { ALL_SCOPES } from './plugin.js';
import { logger } from '../logger.js';

/** Timing-safe compare so the admin key can't be probed byte by byte. */
function adminKeyMatches(presented: string): boolean {
  const expected = config.ADMIN_API_KEY;
  if (!expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!config.ADMIN_API_KEY) {
    void reply
      .code(404)
      .send({ error: 'Provisioning API is disabled (set ADMIN_API_KEY to enable it)' });
    return false;
  }
  const header = req.headers.authorization;
  const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented || !adminKeyMatches(presented)) {
    void reply.code(401).send({ error: 'Invalid admin key' });
    return false;
  }
  return true;
}

const createOrgSchema = z.object({
  /** Display name of the workspace, e.g. the customer's company name. */
  name: z.string().min(1).max(200),
  /** Owner identity. Must be unique across the instance; embedding products
   *  typically synthesize one (e.g. `company-<id>@yourapp.internal`). */
  email: z.string().email(),
  plan: z.enum(['free', 'pro']).optional(),
  /** Label for the API key minted alongside the workspace. */
  keyName: z.string().min(1).max(100).optional(),
});

function mintKey(orgId: string, name: string): { key: string; id: string } {
  const { key, prefix, hash } = generateApiKey();
  const id = nanoid();
  db.insert(schema.apiKeys)
    .values({
      id,
      orgId,
      name,
      keyHash: hash,
      keyPrefix: prefix,
      // Unrestricted on purpose: the embedding product owns the workspace
      // end to end and scoping it would only hide capability from itself.
      scopes: JSON.stringify(['*']),
      createdAt: Date.now(),
    })
    .run();
  return { key, id };
}

function describeOrg(orgId: string) {
  const org = getOrg(orgId);
  if (!org) return undefined;
  const limits = planLimits(org);
  const accounts = sqlite
    .prepare(
      `SELECT id, email, provider, status, last_error AS lastError, created_at AS createdAt
       FROM accounts WHERE org_id = ? ORDER BY created_at`,
    )
    .all(orgId);
  return {
    id: org.id,
    name: org.name,
    plan: org.plan,
    status: org.status,
    createdAt: new Date(org.createdAt).toISOString(),
    limits: {
      maxAccounts: Number.isFinite(limits.maxAccounts) ? limits.maxAccounts : null,
      dailySends: Number.isFinite(limits.dailySends) ? limits.dailySends : null,
    },
    accounts,
  };
}

export function registerProvisioningRoutes(app: FastifyInstance) {
  // Create a workspace and hand back a key for it. Idempotent on the owner
  // email: calling again for the same email returns the existing workspace
  // with a freshly minted key, so a retried provisioning call cannot strand
  // a duplicate tenant.
  app.post('/admin/orgs', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = createOrgSchema.parse(req.body);
    const existing = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, body.email.toLowerCase()))
      .get();
    if (existing) {
      const { key } = mintKey(existing.orgId, body.keyName ?? 'provisioned');
      logger.info({ orgId: existing.orgId }, 'provisioning: re-keyed existing workspace');
      return reply.code(200).send({
        created: false,
        org: describeOrg(existing.orgId),
        apiKey: key,
      });
    }
    // The owner never logs in through the UI in this mode, so the password is
    // random and thrown away; access is via the API key.
    const { orgId } = createOrgWithOwner({
      orgName: body.name,
      email: body.email,
      password: crypto.randomBytes(24).toString('base64url'),
    });
    if (body.plan) {
      db.update(schema.orgs).set({ plan: body.plan }).where(eq(schema.orgs.id, orgId)).run();
    }
    const { key } = mintKey(orgId, body.keyName ?? 'provisioned');
    logger.info({ orgId, name: body.name }, 'provisioning: workspace created');
    return reply.code(201).send({ created: true, org: describeOrg(orgId), apiKey: key });
  });

  app.get('/admin/orgs', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const rows = sqlite
      .prepare(
        `SELECT o.id, o.name, o.plan, o.status, o.created_at AS createdAt,
                (SELECT COUNT(*) FROM accounts a WHERE a.org_id = o.id) AS accounts
         FROM orgs o ORDER BY o.created_at DESC`,
      )
      .all();
    return reply.send({ orgs: rows });
  });

  app.get<{ Params: { orgId: string } }>('/admin/orgs/:orgId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const org = describeOrg(req.params.orgId);
    if (!org) return reply.code(404).send({ error: 'Workspace not found' });
    return reply.send({ org });
  });

  // Rotate: mint a new key for an existing workspace (old keys stay valid
  // until explicitly revoked, so a rollout can overlap).
  app.post<{ Params: { orgId: string } }>('/admin/orgs/:orgId/api-keys', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!getOrg(req.params.orgId)) return reply.code(404).send({ error: 'Workspace not found' });
    const name = z
      .object({ name: z.string().min(1).max(100).optional() })
      .parse(req.body ?? {}).name;
    const { key, id } = mintKey(req.params.orgId, name ?? 'provisioned');
    return reply.code(201).send({ apiKeyId: id, apiKey: key, scopes: ALL_SCOPES });
  });

  app.delete<{ Params: { orgId: string; keyId: string } }>(
    '/admin/orgs/:orgId/api-keys/:keyId',
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const row = db
        .select()
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.id, req.params.keyId))
        .get();
      if (!row || row.orgId !== req.params.orgId) {
        return reply.code(404).send({ error: 'API key not found' });
      }
      db.update(schema.apiKeys)
        .set({ revokedAt: Date.now() })
        .where(eq(schema.apiKeys.id, req.params.keyId))
        .run();
      return reply.code(204).send();
    },
  );
}
