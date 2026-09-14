/**
 * Reputation controller: watches where a mailbox's warmup mail lands and
 * slows, holds or pauses the ramp when placement degrades. Runs at each
 * mailbox's day rollover (from the planner) and immediately after any spam
 * landing (from the detector).
 */

import { eq } from 'drizzle-orm';
import { db, sqlite, schema } from '../db/index.js';
import { logActivity } from '../observability/activity.js';
import { senderSpamRate } from './pool.js';
import { autoPauseWarmup, getWarmupAccount } from './state.js';
import { emitWarmupEvent } from './events.js';
import type { PoolMember } from './pool.js';
import type { WarmupAccount } from '../db/schema.js';

const MIN_SAMPLES = 10;

function bouncesLast24h(accountId: string): number {
  return (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM warmup_landings WHERE from_account_id = ? AND landed = 'bounced' AND landed_at > ?`,
      )
      .get(accountId, Date.now() - 24 * 3600_000) as { n: number }
  ).n;
}

/**
 * Evaluate a member and apply the throttle rules. Returns the updated row
 * when something changed, null otherwise.
 */
export function applyReputation(member: PoolMember, now = Date.now(), trigger: 'daily' | 'spam' = 'daily'): WarmupAccount | null {
  const { settings, account } = member;
  const warm = getWarmupAccount(account.id);
  if (!warm || !settings.autoThrottle) return null;
  if (warm.state !== 'ramping' && warm.state !== 'steady') return null;

  const { rate, samples } = senderSpamRate(account.id, 7);
  const bounces = bouncesLast24h(account.id);

  if (bounces >= 3) {
    return autoPauseWarmup(
      account.id,
      `${bounces} warmup messages bounced in 24h — check the mailbox and its partners`,
      settings.cooldownDays,
    );
  }
  // Young mailbox: spam placements are expected and the rescues are the
  // cure, so neither throttle nor pause — and undo a throttle left from a
  // stricter setting, so the ramp keeps moving.
  const ageMs = now - (warm.startedAt ?? now);
  if (ageMs < settings.protectionAfterDays * 24 * 3600_000) {
    if (warm.throttlePercent < 100) {
      db.update(schema.warmupAccounts)
        .set({ throttlePercent: 100, cleanDays: 0, updatedAt: now })
        .where(eq(schema.warmupAccounts.accountId, account.id))
        .run();
      logActivity({
        category: 'warmup',
        action: 'throttle-lifted',
        status: 'ok',
        accountId: account.id,
        detail: `within the ${settings.protectionAfterDays}-day protection delay; full volume restored`,
      });
      return getWarmupAccount(account.id)!;
    }
    return null;
  }
  if (rate === null || samples < MIN_SAMPLES) return null;

  if (rate >= settings.pauseAtSpamRate) {
    return autoPauseWarmup(
      account.id,
      `${rate.toFixed(0)}% of warmup mail landed in spam or went missing over 7 days (threshold ${settings.pauseAtSpamRate}%)`,
      settings.cooldownDays,
    );
  }
  if (rate >= settings.slowAtSpamRate) {
    if (warm.throttlePercent > 50 || trigger === 'daily') {
      db.update(schema.warmupAccounts)
        .set({ throttlePercent: 50, cleanDays: 0, updatedAt: now })
        .where(eq(schema.warmupAccounts.accountId, account.id))
        .run();
      if (warm.throttlePercent > 50) {
        logActivity({
          category: 'warmup',
          action: 'throttle',
          status: 'failed',
          accountId: account.id,
          error: `${rate.toFixed(0)}% spam/missing over 7 days; volume halved and ramp held`,
        });
        emitWarmupEvent(account, 'warmup.throttled', { spamRate: rate, samples, throttlePercent: 50 });
      }
      return getWarmupAccount(account.id)!;
    }
    return null;
  }
  // Healthy. Count clean days while throttled; lift after three.
  if (warm.throttlePercent < 100 && trigger === 'daily') {
    const cleanDays = warm.cleanDays + 1;
    if (cleanDays >= 3) {
      db.update(schema.warmupAccounts)
        .set({ throttlePercent: 100, cleanDays: 0, updatedAt: now })
        .where(eq(schema.warmupAccounts.accountId, account.id))
        .run();
      logActivity({
        category: 'warmup',
        action: 'throttle-lifted',
        status: 'ok',
        accountId: account.id,
        detail: `3 clean days at ${rate.toFixed(0)}% spam/missing; full volume restored`,
      });
    } else {
      db.update(schema.warmupAccounts)
        .set({ cleanDays, updatedAt: now })
        .where(eq(schema.warmupAccounts.accountId, account.id))
        .run();
    }
    return getWarmupAccount(account.id)!;
  }
  return null;
}
