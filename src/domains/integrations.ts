/**
 * Per-workspace credentials for the registrar and the provisioner, stored
 * encrypted with the instance master key and never sent back to a browser
 * in full.
 */

import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/index.js';
import { encryptSecret, decryptSecret } from '../crypto/secrets.js';
import type { NamecheapConfig } from './namecheap.js';
import type { PiHosting } from './premiuminboxes.js';

export interface PremiumInboxesConfig {
  apiToken: string;
  /** Orders go to this workspace; null = the agency default. */
  workspaceId: string | null;
  workspaceName?: string | null;
  /** Cached from the last successful test, for the settings form. */
  knownWorkspaces?: { id: string; name: string }[];
  /** How Premium Inboxes gets into DNS for the domains: registrar or DNS host login. */
  hosting: PiHosting;
  defaults: {
    emailProvider: 'Google' | 'Microsoft';
    inboxesPerDomain: number;
    prefixVariants: string[];
    profilePictureLink?: string;
    masterInboxEmail?: string;
    insured: boolean;
  };
}

export type IntegrationProvider = 'namecheap' | 'premiuminboxes';
type ConfigOf<P extends IntegrationProvider> = P extends 'namecheap' ? NamecheapConfig : PremiumInboxesConfig;

export function getIntegration<P extends IntegrationProvider>(orgId: string, provider: P): ConfigOf<P> | null {
  const row = db
    .select()
    .from(schema.integrations)
    .where(and(eq(schema.integrations.orgId, orgId), eq(schema.integrations.provider, provider)))
    .get();
  if (!row) return null;
  try {
    return JSON.parse(decryptSecret(row.configEnc)) as ConfigOf<P>;
  } catch {
    return null;
  }
}

export function getIntegrationRow(orgId: string, provider: IntegrationProvider) {
  return db
    .select()
    .from(schema.integrations)
    .where(and(eq(schema.integrations.orgId, orgId), eq(schema.integrations.provider, provider)))
    .get();
}

export function setIntegration<P extends IntegrationProvider>(orgId: string, provider: P, config: ConfigOf<P>): void {
  const now = Date.now();
  const existing = getIntegrationRow(orgId, provider);
  const configEnc = encryptSecret(JSON.stringify(config));
  if (existing) {
    db.update(schema.integrations).set({ configEnc, updatedAt: now, lastError: null }).where(eq(schema.integrations.id, existing.id)).run();
  } else {
    db.insert(schema.integrations).values({ id: nanoid(), orgId, provider, configEnc, createdAt: now, updatedAt: now }).run();
  }
}

export function markIntegration(orgId: string, provider: IntegrationProvider, result: { ok: true } | { ok: false; error: string }): void {
  const row = getIntegrationRow(orgId, provider);
  if (!row) return;
  db.update(schema.integrations)
    .set(result.ok ? { verifiedAt: Date.now(), lastError: null } : { lastError: result.error.slice(0, 500) })
    .where(eq(schema.integrations.id, row.id))
    .run();
}

export function deleteIntegration(orgId: string, provider: IntegrationProvider): void {
  db.delete(schema.integrations).where(and(eq(schema.integrations.orgId, orgId), eq(schema.integrations.provider, provider))).run();
}

/** Workspaces that have a provisioner configured, for the sync worker. */
export function orgsWithIntegration(provider: IntegrationProvider): string[] {
  return db
    .select({ orgId: schema.integrations.orgId })
    .from(schema.integrations)
    .where(eq(schema.integrations.provider, provider))
    .all()
    .map((r) => r.orgId);
}

/** A masked view for the settings form: shows that a secret is set, not what it is. */
export function mask(secret: string | null | undefined): string {
  if (!secret) return '';
  return secret.length <= 6 ? '••••' : secret.slice(0, 3) + '•'.repeat(Math.min(12, secret.length - 5)) + secret.slice(-2);
}
