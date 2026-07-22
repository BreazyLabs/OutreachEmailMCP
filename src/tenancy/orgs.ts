import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { db, sqlite, schema } from '../db/index.js';
import { hashPassword } from '../crypto/credentials.js';
import { config } from '../config.js';
import type { Org } from '../db/schema.js';

export const DEFAULT_ORG_ID = 'org_default';
export const SELFHOST_ADMIN_EMAIL = 'admin@localhost';

export class QuotaError extends Error {
  readonly kind = 'quota';
}

// Idempotent boot seed: the default org always exists (CLI tools and
// self-hosted mode depend on it); in self-hosted mode an admin user row is
// kept in sync with ADMIN_PASSWORD so UI sessions can reference a user.
export function seedTenancy(): void {
  db.insert(schema.orgs)
    .values({
      id: DEFAULT_ORG_ID,
      name: 'Default',
      plan: 'pro',
      status: 'active',
      createdAt: 0,
    })
    .onConflictDoNothing()
    .run();
  if (!config.SAAS_MODE) {
    const passwordHash = hashPassword(config.ADMIN_PASSWORD);
    db.insert(schema.users)
      .values({
        id: 'user_admin',
        orgId: DEFAULT_ORG_ID,
        email: SELFHOST_ADMIN_EMAIL,
        passwordHash,
        role: 'owner',
        createdAt: 0,
      })
      .onConflictDoUpdate({ target: schema.users.email, set: { passwordHash } })
      .run();
  }
}

export function createOrgWithOwner(input: {
  orgName: string;
  email: string;
  password: string;
}): { orgId: string; userId: string } {
  const now = Date.now();
  const orgId = nanoid();
  const userId = nanoid();
  db.insert(schema.orgs)
    .values({ id: orgId, name: input.orgName, plan: 'free', status: 'active', createdAt: now })
    .run();
  db.insert(schema.users)
    .values({
      id: userId,
      orgId,
      email: input.email.toLowerCase(),
      passwordHash: hashPassword(input.password),
      role: 'owner',
      createdAt: now,
    })
    .run();
  return { orgId, userId };
}

export function getOrg(orgId: string): Org | undefined {
  return db.select().from(schema.orgs).where(eq(schema.orgs.id, orgId)).get();
}

export interface PlanLimits {
  maxAccounts: number;
  dailySends: number;
}

export function planLimits(org: Org): PlanLimits {
  if (!config.SAAS_MODE) return { maxAccounts: Infinity, dailySends: Infinity };
  if (org.plan === 'pro') {
    return { maxAccounts: config.PLAN_PRO_MAX_ACCOUNTS, dailySends: config.PLAN_PRO_DAILY_SENDS };
  }
  return { maxAccounts: config.PLAN_FREE_MAX_ACCOUNTS, dailySends: config.PLAN_FREE_DAILY_SENDS };
}

export function countAccounts(orgId: string): number {
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM accounts WHERE org_id = ?`)
    .get(orgId) as { n: number };
  return row.n;
}

export function countSendsLast24h(orgId: string): number {
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM send_jobs j JOIN accounts a ON a.id = j.account_id
       WHERE a.org_id = ? AND j.created_at > ?`,
    )
    .get(orgId, Date.now() - 24 * 3600_000) as { n: number };
  return row.n;
}

// Throws QuotaError when the org may not add another connected account.
export function assertCanAddAccount(orgId: string): void {
  const org = getOrg(orgId);
  if (!org) throw new QuotaError('Unknown organization');
  if (org.status !== 'active') throw new QuotaError('Organization is suspended');
  const limits = planLimits(org);
  if (countAccounts(orgId) >= limits.maxAccounts) {
    throw new QuotaError(
      `Account limit reached (${limits.maxAccounts} on the ${org.plan} plan). Upgrade to connect more.`,
    );
  }
}

// Throws QuotaError when the org may not send right now.
export function assertCanSend(orgId: string): void {
  const org = getOrg(orgId);
  if (!org) throw new QuotaError('Unknown organization');
  if (org.status !== 'active') throw new QuotaError('Organization is suspended');
  const limits = planLimits(org);
  if (limits.dailySends !== Infinity && countSendsLast24h(orgId) >= limits.dailySends) {
    throw new QuotaError(
      `Daily send limit reached (${limits.dailySends}/24h on the ${org.plan} plan). Try later or upgrade.`,
    );
  }
}
