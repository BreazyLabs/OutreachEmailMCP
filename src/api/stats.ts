/**
 * Delivery statistics.
 *
 * Everything is derived from `send_jobs`, which already records the whole
 * lifecycle: queued → sent/failed, then bounced/replied when the inbound
 * poller correlates a DSN or reply back to the job. Consumers that want an
 * event stream use webhooks; this is the pull-based rollup for dashboards
 * that render "how is this mailbox doing" without replaying every event.
 *
 * `bounced` counts sends that the provider accepted and the receiving system
 * later rejected — it is deliberately NOT a subset of `failed` (which means
 * the provider itself refused the submission).
 */

import type { FastifyInstance } from 'fastify';
import { sqlite } from '../db/index.js';
import { orgOf, requireScope, loadAccount } from './plugin.js';

interface StatsRow {
  sent: number;
  failed: number;
  queued: number;
  bounced: number;
  hardBounced: number;
  softBounced: number;
  replied: number;
}

const ZERO: StatsRow = {
  sent: 0,
  failed: 0,
  queued: 0,
  bounced: 0,
  hardBounced: 0,
  softBounced: 0,
  replied: 0,
};

const AGGREGATE = `
  SELECT
    COALESCE(SUM(j.status = 'sent'), 0)                        AS sent,
    COALESCE(SUM(j.status = 'failed'), 0)                      AS failed,
    COALESCE(SUM(j.status IN ('queued', 'sending')), 0)        AS queued,
    COALESCE(SUM(j.bounced_at IS NOT NULL), 0)                 AS bounced,
    COALESCE(SUM(j.bounce_type = 'hard'), 0)                   AS hardBounced,
    COALESCE(SUM(j.bounce_type = 'soft'), 0)                   AS softBounced,
    COALESCE(SUM(j.replied_at IS NOT NULL), 0)                 AS replied
  FROM send_jobs j
  JOIN accounts a ON a.id = j.account_id
`;

/** Rates are only meaningful against what actually went out. */
function withRates(row: StatsRow) {
  const delivered = row.sent;
  const pct = (n: number) => (delivered > 0 ? Math.round((n / delivered) * 10000) / 100 : null);
  return {
    ...row,
    bounceRate: pct(row.bounced),
    hardBounceRate: pct(row.hardBounced),
    replyRate: pct(row.replied),
  };
}

function windowStart(query: Record<string, string | undefined>): number {
  const days = Number(query.days ?? '30');
  const safeDays = Number.isFinite(days) && days > 0 && days <= 365 ? days : 30;
  return Date.now() - safeDays * 24 * 3600_000;
}

export function registerStatsRoutes(app: FastifyInstance) {
  // Org-wide rollup, plus a per-account breakdown so a dashboard can render
  // the whole page from one call.
  app.get<{ Querystring: Record<string, string> }>('/stats', async (req, reply) => {
    if (!requireScope(req, reply, 'read')) return;
    const since = windowStart(req.query);
    const orgId = orgOf(req);
    const total = sqlite
      .prepare(`${AGGREGATE} WHERE a.org_id = ? AND j.created_at >= ?`)
      .get(orgId, since) as StatsRow;
    const perAccount = sqlite
      .prepare(
        `SELECT j.account_id AS accountId, a.email AS email, a.status AS accountStatus,
                COALESCE(SUM(j.status = 'sent'), 0)                 AS sent,
                COALESCE(SUM(j.status = 'failed'), 0)               AS failed,
                COALESCE(SUM(j.status IN ('queued', 'sending')), 0) AS queued,
                COALESCE(SUM(j.bounced_at IS NOT NULL), 0)          AS bounced,
                COALESCE(SUM(j.bounce_type = 'hard'), 0)            AS hardBounced,
                COALESCE(SUM(j.bounce_type = 'soft'), 0)            AS softBounced,
                COALESCE(SUM(j.replied_at IS NOT NULL), 0)          AS replied
         FROM send_jobs j JOIN accounts a ON a.id = j.account_id
         WHERE a.org_id = ? AND j.created_at >= ?
         GROUP BY j.account_id`,
      )
      .all(orgId, since) as (StatsRow & {
      accountId: string;
      email: string;
      accountStatus: string;
    })[];
    return reply.send({
      since: new Date(since).toISOString(),
      total: withRates(total ?? ZERO),
      accounts: perAccount.map((a) => ({
        accountId: a.accountId,
        email: a.email,
        status: a.accountStatus,
        ...withRates(a),
      })),
    });
  });

  app.get<{ Params: { accountId: string }; Querystring: Record<string, string> }>(
    '/accounts/:accountId/stats',
    async (req, reply) => {
      if (!requireScope(req, reply, 'read')) return;
      const account = loadAccount(req.params.accountId, req);
      if (!account) return reply.code(404).send({ error: 'Account not found' });
      const since = windowStart(req.query);
      const row = sqlite
        .prepare(`${AGGREGATE} WHERE j.account_id = ? AND j.created_at >= ?`)
        .get(account.id, since) as StatsRow;
      // Daily series, so a dashboard can draw a trend without N calls.
      const daily = sqlite
        .prepare(
          `SELECT date(j.created_at / 1000, 'unixepoch') AS day,
                  COALESCE(SUM(j.status = 'sent'), 0)        AS sent,
                  COALESCE(SUM(j.status = 'failed'), 0)      AS failed,
                  COALESCE(SUM(j.bounced_at IS NOT NULL), 0) AS bounced,
                  COALESCE(SUM(j.replied_at IS NOT NULL), 0) AS replied
           FROM send_jobs j
           WHERE j.account_id = ? AND j.created_at >= ?
           GROUP BY day ORDER BY day`,
        )
        .all(account.id, since);
      return reply.send({
        account: { id: account.id, email: account.email, status: account.status },
        since: new Date(since).toISOString(),
        total: withRates(row ?? ZERO),
        daily,
      });
    },
  );

  // The bounces themselves — a dashboard needs the addresses to suppress,
  // not just a count.
  app.get<{ Querystring: Record<string, string> }>('/bounces', async (req, reply) => {
    if (!requireScope(req, reply, 'read')) return;
    const since = windowStart(req.query);
    const limit = Math.min(Number(req.query.limit ?? '100') || 100, 500);
    const rows = sqlite
      .prepare(
        `SELECT j.id AS jobId, j.account_id AS accountId, a.email AS account,
                j.subject, j.message_id AS messageId, j.bounced_at AS bouncedAt,
                j.bounce_type AS type, j.bounce_code AS code,
                j.bounce_recipient AS recipient, j.bounce_diagnostic AS diagnostic
         FROM send_jobs j JOIN accounts a ON a.id = j.account_id
         WHERE a.org_id = ? AND j.bounced_at IS NOT NULL AND j.bounced_at >= ?
         ORDER BY j.bounced_at DESC LIMIT ?`,
      )
      .all(orgOf(req), since, limit);
    return reply.send({ bounces: rows });
  });
}
