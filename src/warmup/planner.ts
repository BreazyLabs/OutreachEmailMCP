/**
 * The planner turns a mailbox's settings into today's tasks. It is
 * deterministic (seeded on account + date) and idempotent (tasks carry an
 * idempotency key), so running it twice — or after a crash — changes nothing.
 *
 * Replies, forwards and engagement are NOT planned here: they are scheduled
 * by the detector when mail actually arrives. The planner only decides how
 * many conversations to open, with whom, and when.
 */

import { eq } from 'drizzle-orm';
import { db, sqlite, schema } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { logActivity } from '../observability/activity.js';
import { rngFrom, type Rng } from './rng.js';
import {
  localDate,
  localMinutes,
  localToInstant,
  parseHHMM,
  shiftDate,
  weekdayOf,
} from './clock.js';
import { enqueueTask } from './tasks.js';
import {
  loadPool,
  choosePartner,
  poolTooSmall,
  sentOnDate,
  type PoolMember,
} from './pool.js';
import { applyReputation } from './reputation.js';
import { syncUpstreamState } from './state.js';
import type { WarmupSettings } from './settings.js';

export interface DayTarget {
  target: number;
  openers: number;
  sendingDay: boolean;
  rampValue: number;
  reason: string | null;
}

/** Pure: today's numbers from the ramp, the calendar and the throttle. */
export function computeDayTarget(
  settings: WarmupSettings,
  rampDay: number,
  throttlePercent: number,
  date: string,
  rng: Rng,
  extra: { realSendsToday?: number; poolOk: boolean },
): DayTarget {
  const weekday = weekdayOf(date);
  const weekend = weekday === 0 || weekday === 6;
  const rampValue = settings.slowStart
    ? Math.min(settings.dailyLimit, settings.startVolume + rampDay * settings.increasePerDay)
    : settings.dailyLimit;
  if (!extra.poolOk) {
    return { target: 0, openers: 0, sendingDay: false, rampValue, reason: 'pool too small' };
  }
  if (weekend && settings.weekdaysOnly) {
    return { target: 0, openers: 0, sendingDay: false, rampValue, reason: 'weekend' };
  }
  let target = rampValue;
  if (weekend) target *= settings.weekendFactor;
  if (settings.randomizePercent > 0) {
    const spread = settings.randomizePercent / 100;
    target *= 1 + (rng.next() * 2 - 1) * spread;
  }
  target *= throttlePercent / 100;
  target = Math.round(target);
  if (settings.maxTotalPerDay !== null && extra.realSendsToday !== undefined) {
    target = Math.min(target, Math.max(0, settings.maxTotalPerDay - extra.realSendsToday));
  }
  target = Math.max(0, Math.min(target, settings.dailyLimit));
  if (target === 0) {
    return { target: 0, openers: 0, sendingDay: false, rampValue, reason: weekend ? 'weekend' : 'throttled to zero' };
  }
  // Leave room for the replies the detector will add during the day.
  const expectedReplies = Math.round(target * (settings.replyRate / 100) * 0.5);
  const openers = Math.max(1, target - expectedReplies);
  return { target, openers, sendingDay: true, rampValue, reason: null };
}

/**
 * Pure: `count` send instants inside today's window, drawn from a two-peak
 * distribution (late morning, early afternoon), spaced at least minGap apart,
 * never on a round minute. Slots before `earliestMinutes` are not produced.
 */
export function sampleSendTimes(
  count: number,
  settings: WarmupSettings,
  date: string,
  rng: Rng,
  earliestMinutes = 0,
): number[] {
  if (count <= 0) return [];
  const tz = settings.timezone;
  const windowStart = parseHHMM(settings.sendWindowStart);
  const windowEnd = parseHHMM(settings.sendWindowEnd);
  const start = Math.max(windowStart, earliestMinutes);
  const len = windowEnd - start;
  if (len < 10) return [];
  let gap = settings.minGapMinutes;
  // Cannot fit them all at the configured gap: tighten it rather than drop
  // sends, down to a floor of three minutes.
  if (gap * (count - 1) > len * 0.9) gap = Math.max(3, Math.floor((len * 0.9) / Math.max(1, count - 1)));

  const draws: number[] = [];
  for (let i = 0; i < count; i++) {
    const peak = rng.chance(55) ? 0.3 : 0.68;
    const m = start + rng.normal(peak * len, 0.13 * len);
    draws.push(Math.min(windowEnd - 2, Math.max(start + 1, m)));
  }
  draws.sort((a, b) => a - b);
  for (let i = 1; i < draws.length; i++) {
    const minAt = draws[i - 1]! + gap + rng.int(0, 4);
    if (draws[i]! < minAt) draws[i] = minAt;
  }
  // If pushing apart overflowed the window, slide everything back evenly.
  const overflow = draws[draws.length - 1]! - (windowEnd - 1);
  if (overflow > 0) {
    for (let i = 0; i < draws.length; i++) draws[i] = draws[i]! - overflow * ((i + 1) / draws.length);
    for (let i = 0; i < draws.length; i++) draws[i] = Math.max(start + 1, draws[i]!);
  }
  return draws
    .filter((m) => m <= windowEnd - 1)
    .map((m) => {
      const minute = Math.floor(m);
      const seconds = 1 + rng.int(0, 57);
      return localToInstant(date, minute, tz) + seconds * 1000 + rng.int(0, 999);
    });
}

function realSendsOnDate(accountId: string, dayStart: number, dayEnd: number): number {
  return (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM send_jobs WHERE account_id = ? AND source != 'warmup'
           AND created_at >= ? AND created_at < ?`,
      )
      .get(accountId, dayStart, dayEnd) as { n: number }
  ).n;
}

export interface PlanOutcome {
  accountId: string;
  date: string;
  planned: number;
  target: number;
  reason: string | null;
}

/**
 * Plan one member for its current local date. Safe to call every minute:
 * it returns early unless the date rolled over (or the member never planned).
 */
export function planMember(member: PoolMember, pool: PoolMember[], now = Date.now()): PlanOutcome | null {
  const { settings } = member;
  const tz = settings.timezone;
  const today = localDate(now, tz);
  let warm = member.warm;
  if (warm.lastPlannedDate === today) return null;
  if (warm.state !== 'ramping' && warm.state !== 'steady') return null;

  // Reputation may throttle, hold or pause before today's numbers are set.
  warm = applyReputation(member, now) ?? warm;
  if (warm.state !== 'ramping' && warm.state !== 'steady') return null;

  // Ramp: advance once per completed sending day, and only while the
  // reputation controller is not holding it.
  const yesterday = shiftDate(today, -1);
  let rampDay = warm.rampDay;
  if (
    warm.throttlePercent >= 100 &&
    warm.rampAdvancedDate !== yesterday &&
    sentOnDate(member.account.id, yesterday) > 0
  ) {
    rampDay += 1;
    db.update(schema.warmupAccounts)
      .set({ rampDay, rampAdvancedDate: yesterday, updatedAt: now })
      .where(eq(schema.warmupAccounts.accountId, member.account.id))
      .run();
  }

  const rng = rngFrom('plan', config.masterKey.toString('base64'), member.account.id, today);
  const dayStart = localToInstant(today, 0, tz);
  const dayEnd = localToInstant(shiftDate(today, 1), 0, tz);
  const day = computeDayTarget(settings, rampDay, warm.throttlePercent, today, rng, {
    realSendsToday:
      settings.maxTotalPerDay !== null ? realSendsOnDate(member.account.id, dayStart, dayEnd) : undefined,
    poolOk: !poolTooSmall(pool),
  });

  // Planning mid-day (boot, just enabled): only the rest of the window.
  const nowMinutes = localDate(now, tz) === today ? localMinutes(now, tz) + 3 : 0;
  const times = sampleSendTimes(day.openers, settings, today, rng, nowMinutes);
  const partnersOnThread = new Set<string>([member.account.id]);
  let planned = 0;
  times.forEach((dueAt, seq) => {
    const wantInternal = rng.chance(settings.internalShare);
    const partner = choosePartner(member, pool, rng, { internal: wantInternal, now });
    if (!partner) return;
    let cc: PoolMember | null = null;
    if (rng.chance(settings.ccRate)) {
      cc = choosePartner(member, pool, rng, {
        internal: wantInternal,
        exclude: new Set([partner.account.id, ...partnersOnThread]),
        now,
      });
    }
    const task = enqueueTask({
      accountId: member.account.id,
      counterpartyAccountId: partner.account.id,
      kind: 'send_open',
      dueAt,
      idempotencyKey: `open:${member.account.id}:${today}:${seq}`,
      payload: {
        partnerAccountId: partner.account.id,
        ccAccountId: cc?.account.id ?? null,
        internal: wantInternal && (partner.domain === member.domain || partner.org.id === member.org.id),
        requestReceipt: rng.chance(settings.readReceiptRequestRate),
        date: today,
        seq,
      },
    });
    if (task) planned++;
  });

  const newState = warm.state === 'ramping' && day.rampValue >= settings.dailyLimit && warm.throttlePercent >= 100
    ? 'steady'
    : warm.state;
  db.update(schema.warmupAccounts)
    .set({ lastPlannedDate: today, todayTarget: day.target, state: newState, updatedAt: now })
    .where(eq(schema.warmupAccounts.accountId, member.account.id))
    .run();

  logActivity({
    category: 'warmup',
    action: 'plan',
    status: 'ok',
    accountId: member.account.id,
    detail: `${today}: target ${day.target}, ${planned} conversation${planned === 1 ? '' : 's'} planned, ramp day ${rampDay}${day.reason ? ` (${day.reason})` : ''}`,
  });
  logger.info(
    { account: member.account.email, date: today, target: day.target, planned },
    'warmup day planned',
  );
  return { accountId: member.account.id, date: today, planned, target: day.target, reason: day.reason };
}

/** Plan every member that needs it. Called every minute; cheap when idle. */
export function planAll(now = Date.now()): PlanOutcome[] {
  syncUpstreamState();
  const pool = loadPool();
  const outcomes: PlanOutcome[] = [];
  for (const member of pool) {
    try {
      const outcome = planMember(member, pool, now);
      if (outcome) outcomes.push(outcome);
    } catch (err) {
      logger.warn({ account: member.account.email, err: String(err) }, 'warmup planning failed');
      logActivity({
        category: 'warmup',
        action: 'plan',
        status: 'failed',
        accountId: member.account.id,
        error: String(err),
      });
    }
  }
  return outcomes;
}
