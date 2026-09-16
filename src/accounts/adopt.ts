/**
 * Move a connected mailbox from one workspace into another.
 *
 * Everything that hangs off the account (tokens, SMTP credentials, send jobs,
 * sync state, warmup state) is keyed on the account id and follows it
 * untouched. The one thing that is org-scoped AND account-scoped is a
 * webhook pinned to this account: after the move it would fire for a
 * workspace the subscriber no longer belongs to, so such webhooks in the
 * OLD workspace are deleted rather than left dangling (a nulled account_id
 * would silently widen them to every mailbox in that workspace instead).
 */

import { and, eq, ne } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { assertCanAddAccount, getOrg } from '../tenancy/orgs.js';
import { logActivity } from '../observability/activity.js';
import type { Account } from '../db/schema.js';

export class AdoptError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
  }
}

export function adoptAccount(targetOrgId: string, accountId: string): { account: Account; fromOrgId: string } {
  if (!getOrg(targetOrgId)) throw new AdoptError('Workspace not found', 404);
  const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
  if (!account) throw new AdoptError('Unknown account', 404);
  const fromOrgId = account.orgId;
  if (fromOrgId === targetOrgId) return { account, fromOrgId };
  // Throws QuotaError when the target is full or suspended; the caller maps it.
  assertCanAddAccount(targetOrgId);
  const now = Date.now();
  db.update(schema.accounts).set({ orgId: targetOrgId, updatedAt: now }).where(eq(schema.accounts.id, accountId)).run();
  db.delete(schema.webhooks)
    .where(and(eq(schema.webhooks.accountId, accountId), ne(schema.webhooks.orgId, targetOrgId)))
    .run();
  logActivity({
    category: 'api',
    action: 'adopt',
    status: 'ok',
    orgId: targetOrgId,
    accountId,
    accountEmail: account.email,
    detail: `moved from workspace ${fromOrgId}`,
  });
  const fresh = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get() ?? account;
  return { account: fresh, fromOrgId };
}

/** Every mailbox on the instance with the workspace it belongs to. */
export function listAllAccounts(): {
  id: string;
  email: string;
  provider: Account['provider'];
  status: Account['status'];
  lastError: string | null;
  createdAt: number;
  orgId: string;
  orgName: string | null;
}[] {
  return db
    .select({
      id: schema.accounts.id,
      email: schema.accounts.email,
      provider: schema.accounts.provider,
      status: schema.accounts.status,
      lastError: schema.accounts.lastError,
      createdAt: schema.accounts.createdAt,
      orgId: schema.accounts.orgId,
      orgName: schema.orgs.name,
    })
    .from(schema.accounts)
    .leftJoin(schema.orgs, eq(schema.orgs.id, schema.accounts.orgId))
    .orderBy(schema.accounts.createdAt)
    .all();
}
