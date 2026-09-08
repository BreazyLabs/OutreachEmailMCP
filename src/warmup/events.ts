/**
 * Warmup webhook events. Off by default per org: most consumers only want
 * the mailbox's real traffic, and warmup is meant to be invisible.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { dispatchEvent } from '../inbound/webhooks.js';
import type { Account } from '../db/schema.js';

export const WARMUP_EVENTS = [
  'warmup.enabled',
  'warmup.disabled',
  'warmup.paused',
  'warmup.resumed',
  'warmup.throttled',
  'warmup.spam_detected',
  'warmup.rescued',
] as const;

export type WarmupEventName = (typeof WARMUP_EVENTS)[number];

export function emitWarmupEvent(
  account: Pick<Account, 'id' | 'email' | 'provider' | 'orgId'>,
  event: WarmupEventName,
  data: Record<string, unknown>,
): void {
  const org = db
    .select({ emit: schema.orgs.warmupEmitWebhooks })
    .from(schema.orgs)
    .where(eq(schema.orgs.id, account.orgId))
    .get();
  if (!org?.emit) return;
  dispatchEvent(
    {
      event,
      account: { id: account.id, email: account.email, provider: account.provider },
      warmup: data,
    },
    account.orgId,
  );
}
