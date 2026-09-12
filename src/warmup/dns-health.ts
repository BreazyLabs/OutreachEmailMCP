/**
 * Sending-domain DNS posture: SPF, DKIM, DMARC and MX, checked per domain
 * and cached in domain_health. Warmup cannot help a domain whose mail fails
 * authentication, so the dashboard and the daily health mail say so.
 */

import dns from 'node:dns/promises';
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { logger } from '../logger.js';
import { logActivity } from '../observability/activity.js';
import type { DomainHealth } from '../db/schema.js';

export interface Resolver {
  txt(name: string): Promise<string[]>;
  mx(name: string): Promise<{ exchange: string; priority: number }[]>;
}

const NXDOMAIN = new Set(['ENOTFOUND', 'ENODATA', 'ESERVFAIL']);

export const systemResolver: Resolver = {
  async txt(name) {
    try {
      const rows = await dns.resolveTxt(name);
      return rows.map((chunks) => chunks.join(''));
    } catch (err) {
      if (NXDOMAIN.has((err as { code?: string }).code ?? '')) return [];
      throw err;
    }
  },
  async mx(name) {
    try {
      return await dns.resolveMx(name);
    } catch (err) {
      if (NXDOMAIN.has((err as { code?: string }).code ?? '')) return [];
      throw err;
    }
  },
};

// Google Workspace signs with "google"; Microsoft 365 with selector1/2; the
// rest are common defaults for other senders.
const DKIM_SELECTORS = ['google', 'selector1', 'selector2', 'default', 'dkim', 'k1', 'mail', 's1', 's2'];

export interface DomainCheck {
  domain: string;
  spf: string | null;
  spfOk: boolean;
  dmarc: string | null;
  dmarcPolicy: string | null;
  dmarcOk: boolean;
  dkimSelectors: string[];
  dkimOk: boolean;
  mx: string[];
  mxOk: boolean;
  issues: string[];
  error: string | null;
}

export async function checkDomain(domain: string, resolver: Resolver = systemResolver): Promise<DomainCheck> {
  const out: DomainCheck = {
    domain,
    spf: null, spfOk: false,
    dmarc: null, dmarcPolicy: null, dmarcOk: false,
    dkimSelectors: [], dkimOk: false,
    mx: [], mxOk: false,
    issues: [],
    error: null,
  };
  try {
    const [txt, mx, dmarcTxt, ...dkim] = await Promise.all([
      resolver.txt(domain),
      resolver.mx(domain),
      resolver.txt(`_dmarc.${domain}`),
      ...DKIM_SELECTORS.map((s) => resolver.txt(`${s}._domainkey.${domain}`).catch(() => [] as string[])),
    ]);

    // SPF
    const spfRecords = txt.filter((t) => /^v=spf1\b/i.test(t.trim()));
    if (spfRecords.length === 0) out.issues.push('No SPF record');
    else if (spfRecords.length > 1) out.issues.push('More than one SPF record (receivers treat that as a permanent error)');
    else {
      out.spf = spfRecords[0]!;
      const spf = out.spf.toLowerCase();
      if (/\+all\b/.test(spf)) out.issues.push('SPF ends with +all (allows anyone to send as the domain)');
      else if (!/[-~]all\b/.test(spf)) out.issues.push('SPF has no -all/~all terminator');
      const mxHosts = mx.map((m) => m.exchange.toLowerCase());
      const google = mxHosts.some((h) => h.endsWith('google.com') || h.endsWith('googlemail.com'));
      const microsoft = mxHosts.some((h) => h.endsWith('outlook.com') || h.includes('protection.outlook'));
      if (google && !spf.includes('_spf.google.com')) out.issues.push('SPF does not include _spf.google.com although mail is on Google');
      if (microsoft && !spf.includes('spf.protection.outlook.com')) out.issues.push('SPF does not include spf.protection.outlook.com although mail is on Microsoft');
      out.spfOk = out.issues.length === 0 || !out.issues.some((i) => i.startsWith('SPF') || i.startsWith('No SPF') || i.startsWith('More than one SPF'));
    }

    // DMARC
    const dmarcRecords = dmarcTxt.filter((t) => /^v=DMARC1\b/i.test(t.trim()));
    if (dmarcRecords.length === 0) out.issues.push('No DMARC record (_dmarc TXT)');
    else {
      out.dmarc = dmarcRecords[0]!;
      const policy = /\bp=([a-z]+)/i.exec(out.dmarc)?.[1]?.toLowerCase() ?? null;
      out.dmarcPolicy = policy;
      if (!policy) out.issues.push('DMARC record has no p= policy');
      else {
        out.dmarcOk = true;
        if (policy === 'none') out.issues.push('DMARC policy is p=none (monitoring only; quarantine or reject is what receivers reward)');
      }
    }

    // DKIM
    DKIM_SELECTORS.forEach((selector, i) => {
      const records = dkim[i] ?? [];
      if (records.some((r) => /v=DKIM1|\bp=[A-Za-z0-9+/]/.test(r))) out.dkimSelectors.push(selector);
    });
    out.dkimOk = out.dkimSelectors.length > 0;
    if (!out.dkimOk) out.issues.push('No DKIM key found on the usual selectors (google, selector1, selector2, …)');

    // MX
    out.mx = mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange.toLowerCase());
    out.mxOk = out.mx.length > 0;
    if (!out.mxOk) out.issues.push('No MX record');
  } catch (err) {
    out.error = String(err).slice(0, 300);
    out.issues.push(`DNS lookup failed: ${out.error}`);
  }
  return out;
}

export function domainOfEmail(email: string): string {
  return (email.split('@')[1] ?? '').toLowerCase();
}

function saveCheck(c: DomainCheck): void {
  db.insert(schema.domainHealth)
    .values({
      domain: c.domain,
      checkedAt: Date.now(),
      spf: c.spf,
      spfOk: c.spfOk ? 1 : 0,
      dmarc: c.dmarc,
      dmarcPolicy: c.dmarcPolicy,
      dmarcOk: c.dmarcOk ? 1 : 0,
      dkimSelectorsJson: JSON.stringify(c.dkimSelectors),
      dkimOk: c.dkimOk ? 1 : 0,
      mxJson: JSON.stringify(c.mx),
      mxOk: c.mxOk ? 1 : 0,
      issuesJson: JSON.stringify(c.issues),
      error: c.error,
    })
    .onConflictDoUpdate({
      target: schema.domainHealth.domain,
      set: {
        checkedAt: Date.now(),
        spf: c.spf,
        spfOk: c.spfOk ? 1 : 0,
        dmarc: c.dmarc,
        dmarcPolicy: c.dmarcPolicy,
        dmarcOk: c.dmarcOk ? 1 : 0,
        dkimSelectorsJson: JSON.stringify(c.dkimSelectors),
        dkimOk: c.dkimOk ? 1 : 0,
        mxJson: JSON.stringify(c.mx),
        mxOk: c.mxOk ? 1 : 0,
        issuesJson: JSON.stringify(c.issues),
        error: c.error,
      },
    })
    .run();
}

/** Every domain with a connected mailbox on the instance. */
export function connectedDomains(orgId?: string): string[] {
  const rows = orgId
    ? db.select({ email: schema.accounts.email }).from(schema.accounts).where(eq(schema.accounts.orgId, orgId)).all()
    : db.select({ email: schema.accounts.email }).from(schema.accounts).all();
  return [...new Set(rows.map((r) => domainOfEmail(r.email)).filter(Boolean))].sort();
}

/**
 * Check every connected domain whose result is older than `maxAgeMs`
 * (or all of them when `force`). Sequential with a small delay so a large
 * pool does not fire hundreds of lookups at once.
 */
export async function refreshDomainHealth(opts: { orgId?: string; maxAgeMs?: number; force?: boolean } = {}): Promise<number> {
  const maxAge = opts.maxAgeMs ?? 24 * 3600_000;
  const domains = connectedDomains(opts.orgId);
  const existing = new Map(
    domains.length
      ? db.select().from(schema.domainHealth).where(inArray(schema.domainHealth.domain, domains)).all().map((r) => [r.domain, r])
      : [],
  );
  let checked = 0;
  for (const domain of domains) {
    const prev = existing.get(domain);
    if (!opts.force && prev && Date.now() - prev.checkedAt < maxAge) continue;
    const result = await checkDomain(domain);
    saveCheck(result);
    checked++;
    const had = prev ? (JSON.parse(prev.issuesJson ?? '[]') as string[]).length : -1;
    if (result.issues.length > 0 && result.issues.length !== had) {
      logActivity({
        category: 'warmup',
        action: 'dns-check',
        status: 'failed',
        detail: domain,
        error: result.issues.join('; ').slice(0, 900),
      });
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (checked) logger.info({ checked }, 'domain DNS health refreshed');
  return checked;
}

export function domainHealthFor(domains: string[]): Map<string, DomainHealth> {
  if (domains.length === 0) return new Map();
  return new Map(
    db.select().from(schema.domainHealth).where(inArray(schema.domainHealth.domain, domains)).all().map((r) => [r.domain, r]),
  );
}

export function issuesOf(row: DomainHealth | undefined): string[] {
  if (!row) return [];
  try {
    return JSON.parse(row.issuesJson ?? '[]') as string[];
  } catch {
    return [];
  }
}

/** Compact verdict for a table cell. */
export function dnsVerdict(row: DomainHealth | undefined): 'ok' | 'warn' | 'bad' | 'unchecked' {
  if (!row) return 'unchecked';
  if (row.error) return 'warn';
  if (!row.spfOk || !row.dkimOk || !row.dmarcOk || !row.mxOk) return 'bad';
  return issuesOf(row).length ? 'warn' : 'ok';
}
