import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { and, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { logActivity } from '../observability/activity.js';
import { getAccessToken } from '../auth/tokens.js';
import { mailboxIsReachable } from '../providers/oauth.js';
import { loadTlsMaterial } from '../smtp/certs.js';
import { countAccounts, countSendsLast24h, planLimits } from '../tenancy/orgs.js';
import { buildMime } from '../api/messages-send.js';
import { enqueueSend } from '../queue/sendQueue.js';
import type { Account, Org } from '../db/schema.js';

// A daily sweep over everything that can quietly stop working: mailbox access,
// tokens, the send queue, inbound polling, webhooks, quotas, TLS material and
// disk. Anything that would otherwise only show up as silence gets mailed out.

export type Severity = 'critical' | 'warning';

export interface Finding {
  severity: Severity;
  area: string;
  title: string;
  detail: string;
}

export interface HealthReport {
  orgId: string;
  orgName: string;
  checkedAt: number;
  accountsChecked: number;
  findings: Finding[];
}

const DAY_MS = 24 * 3600_000;

function fmtAge(ms: number): string {
  const hours = Math.floor(ms / 3600_000);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// --- individual checks -----------------------------------------------------

// Live probe per account: proves the refresh token still works AND that a
// mailbox is still attached (licences do get revoked under you).
async function checkAccounts(accounts: Account[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const account of accounts) {
    if (account.status !== 'active') {
      findings.push({
        severity: account.status === 'auth_error' ? 'critical' : 'warning',
        area: 'account',
        title: `${account.email} is ${account.status.replace('_', ' ')}`,
        detail:
          account.lastError ??
          (account.status === 'auth_error'
            ? 'Needs reconnecting through a connect link.'
            : 'Not sending or receiving.'),
      });
      continue;
    }
    let token: string;
    try {
      token = await getAccessToken(account.id);
    } catch (err) {
      findings.push({
        severity: 'critical',
        area: 'account',
        title: `${account.email} cannot refresh its access token`,
        detail: `${String(err)} — the mailbox must be reconnected before it can send or receive.`,
      });
      continue;
    }
    const reachable = await mailboxIsReachable(
      account.provider as 'google' | 'microsoft',
      token,
    );
    if (!reachable.ok) {
      findings.push({
        severity: 'critical',
        area: 'account',
        title: `${account.email} has no reachable mailbox`,
        detail: `${reachable.reason} — usually a licence removed or the mailbox moved on-premise.`,
      });
    }
  }
  return findings;
}

function checkSendQueue(accountIds: string[]): Finding[] {
  if (!accountIds.length) return [];
  const findings: Finding[] = [];
  const since = Date.now() - DAY_MS;

  const failed = db
    .select()
    .from(schema.sendJobs)
    .where(
      and(
        inArray(schema.sendJobs.accountId, accountIds),
        eq(schema.sendJobs.status, 'failed'),
        gt(schema.sendJobs.createdAt, since),
      ),
    )
    .all();
  if (failed.length) {
    const sample = failed[0]!;
    findings.push({
      severity: 'critical',
      area: 'sending',
      title: `${failed.length} message${failed.length === 1 ? '' : 's'} failed to send in the last 24h`,
      detail: `Most recent error: ${sample.lastError ?? 'unknown'}`,
    });
  }

  // Queued long past the point where retries should have cleared it
  const stuck = db
    .select()
    .from(schema.sendJobs)
    .where(
      and(
        inArray(schema.sendJobs.accountId, accountIds),
        inArray(schema.sendJobs.status, ['queued', 'sending']),
        lt(schema.sendJobs.createdAt, Date.now() - 2 * 3600_000),
      ),
    )
    .all();
  if (stuck.length) {
    findings.push({
      severity: 'warning',
      area: 'sending',
      title: `${stuck.length} message${stuck.length === 1 ? '' : 's'} stuck in the queue for over 2h`,
      detail: `Oldest queued ${fmtAge(Date.now() - (stuck[0]?.createdAt ?? Date.now()))}. Last error: ${
        stuck[0]?.lastError ?? 'none recorded'
      }`,
    });
  }
  return findings;
}

function checkInboundPolling(accounts: Account[]): Finding[] {
  const findings: Finding[] = [];
  for (const account of accounts) {
    if (account.status !== 'active') continue;
    const state = db
      .select()
      .from(schema.syncState)
      .where(eq(schema.syncState.accountId, account.id))
      .get();
    if (!state) {
      findings.push({
        severity: 'warning',
        area: 'inbound',
        title: `${account.email} has never polled for new mail`,
        detail: 'No sync cursor was ever anchored — replies will not be detected.',
      });
      continue;
    }
    if (state.lastError) {
      findings.push({
        severity: 'warning',
        area: 'inbound',
        title: `${account.email} inbound poll is failing`,
        detail: state.lastError,
      });
    }
    const last = state.lastPolledAt ?? 0;
    if (Date.now() - last > 6 * 3600_000) {
      findings.push({
        severity: 'warning',
        area: 'inbound',
        title: `${account.email} has not polled successfully for over 6h`,
        detail: last ? `Last successful poll ${fmtAge(Date.now() - last)}.` : 'Never polled.',
      });
    }
  }
  return findings;
}

function checkWebhooks(orgId: string): Finding[] {
  const hooks = db.select().from(schema.webhooks).where(eq(schema.webhooks.orgId, orgId)).all();
  if (!hooks.length) return [];
  const failed = db
    .select()
    .from(schema.webhookDeliveries)
    .where(
      and(
        inArray(
          schema.webhookDeliveries.webhookId,
          hooks.map((h) => h.id),
        ),
        eq(schema.webhookDeliveries.status, 'failed'),
        gt(schema.webhookDeliveries.createdAt, Date.now() - DAY_MS),
      ),
    )
    .all();
  if (!failed.length) return [];
  return [
    {
      severity: 'warning',
      area: 'webhooks',
      title: `${failed.length} webhook deliver${failed.length === 1 ? 'y' : 'ies'} failed in the last 24h`,
      detail: `Most recent: HTTP ${failed[0]?.responseStatus ?? '-'} ${failed[0]?.lastError ?? ''}`.trim(),
    },
  ];
}

function checkQuotas(org: Org): Finding[] {
  const findings: Finding[] = [];
  const limits = planLimits(org);
  if (Number.isFinite(limits.maxAccounts)) {
    const used = countAccounts(org.id);
    if (used >= limits.maxAccounts) {
      findings.push({
        severity: 'warning',
        area: 'quota',
        title: `Mailbox limit reached (${used}/${limits.maxAccounts})`,
        detail: `No further mailboxes can be connected on the ${org.plan} plan.`,
      });
    }
  }
  if (Number.isFinite(limits.dailySends)) {
    const sends = countSendsLast24h(org.id);
    if (sends >= limits.dailySends * 0.8) {
      findings.push({
        severity: sends >= limits.dailySends ? 'critical' : 'warning',
        area: 'quota',
        title: `Daily send quota at ${sends}/${limits.dailySends}`,
        detail:
          sends >= limits.dailySends
            ? 'Further sends are being deferred until the window rolls.'
            : 'Approaching the plan limit for the last 24h.',
      });
    }
  }
  return findings;
}

// Infrastructure the whole instance shares, not any one workspace.
function checkInfrastructure(): Finding[] {
  const findings: Finding[] = [];

  try {
    const { cert } = loadTlsMaterial();
    const x509 = new crypto.X509Certificate(cert);
    const daysLeft = Math.floor((Date.parse(x509.validTo) - Date.now()) / DAY_MS);
    if (daysLeft < 21) {
      findings.push({
        severity: daysLeft < 7 ? 'critical' : 'warning',
        area: 'tls',
        title: `SMTP/IMAP certificate expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
        detail: `Subject ${x509.subject}. Sequencers will refuse to connect once it expires.`,
      });
    }
  } catch (err) {
    findings.push({
      severity: 'warning',
      area: 'tls',
      title: 'Could not read the SMTP/IMAP certificate',
      detail: String(err),
    });
  }

  try {
    const stat = fs.statfsSync(config.dataDir);
    const freeBytes = stat.bavail * stat.bsize;
    const totalBytes = stat.blocks * stat.bsize;
    const freePct = totalBytes ? (freeBytes / totalBytes) * 100 : 100;
    const freeGb = freeBytes / 1024 ** 3;
    if (freeGb < 1 || freePct < 10) {
      findings.push({
        severity: freeGb < 0.5 ? 'critical' : 'warning',
        area: 'disk',
        title: `Only ${freeGb.toFixed(1)} GB free on the data volume (${freePct.toFixed(0)}%)`,
        detail: `${config.dataDir} holds the database, the message spool and TLS material. A full volume stops mail being accepted.`,
      });
    }
  } catch (err) {
    logger.debug({ err: String(err) }, 'health check: statfs unavailable');
  }

  return findings;
}

function checkRecentFailures(orgId: string): Finding[] {
  const rows = db
    .select()
    .from(schema.activityLog)
    .where(
      and(
        eq(schema.activityLog.orgId, orgId),
        eq(schema.activityLog.status, 'failed'),
        gt(schema.activityLog.createdAt, Date.now() - DAY_MS),
      ),
    )
    .all();
  // Poll and delivery failures are reported in detail by their own checks.
  const others = rows.filter((r) => r.category !== 'poll' && r.category !== 'delivery');
  if (others.length < 5) return [];
  const byCategory = new Map<string, number>();
  for (const r of others) {
    byCategory.set(`${r.category}/${r.action}`, (byCategory.get(`${r.category}/${r.action}`) ?? 0) + 1);
  }
  const summary = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ×${n}`)
    .join(', ');
  return [
    {
      severity: 'warning',
      area: 'activity',
      title: `${others.length} failed operations in the last 24h`,
      detail: `${summary}. Full detail at ${config.BASE_URL.replace(/\/$/, '')}/ui/activity?status=failed`,
    },
  ];
}

// --- report assembly and delivery -----------------------------------------

export async function runHealthCheck(org: Org, includeInfrastructure: boolean): Promise<HealthReport> {
  const accounts = db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.orgId, org.id))
    .all();
  const accountIds = accounts.map((a) => a.id);

  const findings: Finding[] = [
    ...(await checkAccounts(accounts)),
    ...checkSendQueue(accountIds),
    ...checkInboundPolling(accounts),
    ...checkWebhooks(org.id),
    ...checkQuotas(org),
    ...checkRecentFailures(org.id),
    ...(includeInfrastructure ? checkInfrastructure() : []),
  ];

  if (!accounts.length) {
    findings.push({
      severity: 'warning',
      area: 'account',
      title: 'No mailboxes are connected',
      detail: 'Nothing can be sent or received until a mailbox is connected.',
    });
  }

  return {
    orgId: org.id,
    orgName: org.name,
    checkedAt: Date.now(),
    accountsChecked: accounts.length,
    findings,
  };
}

function renderText(report: HealthReport): string {
  const critical = report.findings.filter((f) => f.severity === 'critical');
  const warning = report.findings.filter((f) => f.severity === 'warning');
  const lines: string[] = [
    `OutreachEmailMCP daily health check — ${report.orgName}`,
    new Date(report.checkedAt).toUTCString(),
    '',
    `Mailboxes checked: ${report.accountsChecked}`,
    `Critical: ${critical.length}   Warnings: ${warning.length}`,
    '',
  ];
  for (const [label, group] of [
    ['CRITICAL', critical],
    ['WARNING', warning],
  ] as const) {
    if (!group.length) continue;
    lines.push(`── ${label} ──`);
    for (const f of group) {
      lines.push(`• [${f.area}] ${f.title}`);
      lines.push(`  ${f.detail}`);
    }
    lines.push('');
  }
  if (!report.findings.length) lines.push('Everything healthy — no issues found.');
  lines.push(`Dashboard: ${config.BASE_URL.replace(/\/$/, '')}/ui`);
  return lines.join('\n');
}

// Sends from the healthiest mailbox in the workspace: a report nobody receives
// is worse than no report at all.
function reportSender(orgId: string): Account | null {
  return (
    db
      .select()
      .from(schema.accounts)
      .where(and(eq(schema.accounts.orgId, orgId), eq(schema.accounts.status, 'active')))
      .orderBy(desc(schema.accounts.createdAt))
      .all()
      .find((a) => !a.lastError) ?? null
  );
}

function recipientsFor(orgId: string): string[] {
  if (config.HEALTH_REPORT_TO) {
    return config.HEALTH_REPORT_TO.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.orgId, orgId))
    .all()
    .map((u) => u.email)
    .filter((e) => !e.endsWith('@localhost'));
}

export async function sendHealthReport(report: HealthReport): Promise<'sent' | 'skipped' | 'undeliverable'> {
  const noteworthy = report.findings.length > 0;
  if (!noteworthy && !config.HEALTH_REPORT_ALWAYS) return 'skipped';

  const to = recipientsFor(report.orgId);
  const sender = reportSender(report.orgId);
  if (!to.length || !sender) {
    logger.warn(
      { orgId: report.orgId, recipients: to.length, sender: sender?.email ?? null },
      'health report has nowhere to go',
    );
    return 'undeliverable';
  }

  const critical = report.findings.filter((f) => f.severity === 'critical').length;
  const warnings = report.findings.length - critical;
  const subject = report.findings.length
    ? `[${critical ? 'CRITICAL' : 'WARN'}] ${report.orgName} health: ${critical} critical, ${warnings} warning${warnings === 1 ? '' : 's'}`
    : `[OK] ${report.orgName} health: all clear`;

  const text = renderText(report);
  const raw = await buildMime({ from: sender.email, to, subject, text });
  enqueueSend({
    accountId: sender.id,
    source: 'api',
    raw,
    envelope: { from: sender.email, to },
    subject,
  });
  return 'sent';
}

export async function runAndReportAll(): Promise<void> {
  const orgs = db.select().from(schema.orgs).all();
  // Infrastructure findings belong to whoever operates the box; with an
  // explicit report address that is the operator, otherwise nobody gets them
  // twice — only the first workspace's report carries them.
  let infrastructureAssigned = false;
  for (const org of orgs) {
    const accountCount = countAccounts(org.id);
    if (!accountCount && orgs.length > 1) continue; // idle tenant, nothing to say
    const includeInfrastructure = Boolean(config.HEALTH_REPORT_TO) || !infrastructureAssigned;
    infrastructureAssigned = true;
    try {
      const report = await runHealthCheck(org, includeInfrastructure);
      const outcome = await sendHealthReport(report);
      const critical = report.findings.filter((f) => f.severity === 'critical').length;
      logger.info(
        { org: org.name, findings: report.findings.length, critical, outcome },
        'health check complete',
      );
      logActivity({
        category: 'health',
        action: 'daily-check',
        status: critical ? 'failed' : 'ok',
        orgId: org.id,
        detail: `${report.accountsChecked} mailboxes checked · ${critical} critical · ${
          report.findings.length - critical
        } warnings · report ${outcome}`,
        error: report.findings.length
          ? report.findings.map((f) => `[${f.severity}] ${f.title}`).join('; ')
          : undefined,
      });
    } catch (err) {
      logger.error({ org: org.name, err: String(err) }, 'health check failed');
      logActivity({
        category: 'health',
        action: 'daily-check',
        status: 'failed',
        orgId: org.id,
        error: `Health check itself failed: ${String(err)}`,
      });
    }
  }
}

function alreadyRanToday(): boolean {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  return Boolean(
    db
      .select({ id: schema.activityLog.id })
      .from(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.category, 'health'),
          gt(schema.activityLog.createdAt, startOfDay.getTime()),
        ),
      )
      .get(),
  );
}

// Checks every 10 minutes whether the report hour has arrived; the activity
// log is the record of "already ran", so a restart cannot double-send.
export function startHealthReporter(): () => void {
  const CHECK_INTERVAL = 10 * 60_000;
  const timer = setInterval(() => {
    if (new Date().getUTCHours() !== config.HEALTH_REPORT_HOUR) return;
    if (alreadyRanToday()) return;
    void runAndReportAll();
  }, CHECK_INTERVAL);
  timer.unref();
  logger.info(
    { hourUtc: config.HEALTH_REPORT_HOUR, to: config.HEALTH_REPORT_TO || 'workspace owners' },
    'daily health reporter started',
  );
  return () => clearInterval(timer);
}

export { renderText as renderHealthReportText };
export const healthReportPath = () => path.join(config.dataDir, 'health');
