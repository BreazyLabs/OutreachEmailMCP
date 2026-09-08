/**
 * A single health number per mailbox, and a rollup per workspace, so the
 * dashboard answers "is warmup working" without reading six columns.
 *
 * The score starts at 100 and loses points for the things that actually
 * hurt deliverability (spam and missing placements, bounces), for the engine
 * having to intervene (throttle, auto-pause), and for a mailbox that cannot
 * engage (no write scope) or is not sending at all. It is null until there
 * is enough placement data to say anything.
 */

import type { AccountWarmupSummary } from './stats.js';

export type HealthLabel = 'healthy' | 'watch' | 'at_risk' | 'no_data' | 'off';

export interface Health {
  score: number | null;
  label: HealthLabel;
  /** Human reasons, most important first. */
  reasons: string[];
}

const MIN_SAMPLES = 5;

export function healthOf(a: AccountWarmupSummary): Health {
  if (!a.enabled || a.state === 'off') return { score: null, label: 'off', reasons: ['Not in the pool'] };
  const p = a.placement7d;
  const decided = p.inbox + p.category + p.spam + p.missing;
  const reasons: string[] = [];
  let score = 100;

  if (a.state === 'blocked_upstream') {
    reasons.push('Account is not active; warmup is waiting');
    score -= 50;
  }
  if (a.state === 'auto_paused') {
    reasons.push('Auto-paused by the reputation controller');
    score -= 40;
  } else if (a.throttlePercent < 100 && (a.state === 'ramping' || a.state === 'steady')) {
    reasons.push(`Throttled to ${a.throttlePercent}% after poor placement`);
    score -= 10;
  }
  if (!a.canWrite) {
    reasons.push('No mailbox-write access: cannot read, star or rescue');
    score -= 10;
  }
  if (p.bounced > 0) {
    reasons.push(`${p.bounced} bounce${p.bounced === 1 ? '' : 's'} this week`);
    score -= Math.min(45, 15 * p.bounced);
  }

  if (decided >= MIN_SAMPLES) {
    const spamPct = (p.spam / decided) * 100;
    const missingPct = (p.missing / decided) * 100;
    const categoryPct = (p.category / decided) * 100;
    if (spamPct > 0) {
      reasons.push(`${spamPct.toFixed(0)}% of sent warmup mail landed in spam`);
      score -= spamPct * 3;
    }
    if (missingPct > 0) {
      reasons.push(`${missingPct.toFixed(0)}% never arrived anywhere`);
      score -= missingPct * 2;
    }
    if (categoryPct >= 20) {
      reasons.push(`${categoryPct.toFixed(0)}% landed in Promotions/Other (fixed automatically)`);
      score -= categoryPct * 0.5;
    }
  } else if (reasons.length === 0) {
    const started = a.startedAt ?? Date.now();
    const days = Math.floor((Date.now() - started) / 86_400_000);
    if (days >= 2 && a.todaySent === 0 && p.total === 0) {
      reasons.push('Enabled for days but nothing sent yet — check the pool size and send window');
      return { score: 40, label: 'at_risk', reasons };
    }
    return { score: null, label: 'no_data', reasons: ['Not enough placements yet — a few days of sending are needed'] };
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  if (reasons.length === 0) reasons.push('Everything landing in the inbox');
  return { score, label: score >= 85 ? 'healthy' : score >= 60 ? 'watch' : 'at_risk', reasons };
}

export interface OrgHealth {
  score: number | null;
  label: HealthLabel;
  counts: Record<HealthLabel, number>;
}

/** Placement-weighted mean of the mailboxes that have data. */
export function orgHealth(summaries: AccountWarmupSummary[]): OrgHealth {
  const counts: Record<HealthLabel, number> = { healthy: 0, watch: 0, at_risk: 0, no_data: 0, off: 0 };
  let weighted = 0;
  let weight = 0;
  for (const s of summaries) {
    const h = healthOf(s);
    counts[h.label]++;
    if (h.score === null) continue;
    const p = s.placement7d;
    const w = Math.max(1, p.inbox + p.category + p.spam + p.missing);
    weighted += h.score * w;
    weight += w;
  }
  if (weight === 0) {
    const anyEnabled = counts.no_data + counts.at_risk > 0;
    return { score: null, label: anyEnabled ? 'no_data' : 'off', counts };
  }
  const score = Math.round(weighted / weight);
  return { score, label: score >= 85 ? 'healthy' : score >= 60 ? 'watch' : 'at_risk', counts };
}

export const HEALTH_LABELS: Record<HealthLabel, string> = {
  healthy: 'Healthy',
  watch: 'Watch',
  at_risk: 'At risk',
  no_data: 'Warming up',
  off: 'Off',
};
