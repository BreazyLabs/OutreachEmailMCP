/**
 * From a brand word to connected mailboxes: suggest and buy domains at the
 * registrar, place the mailbox order at the provisioner, mirror the order's
 * progress, and show which delivered mailboxes are already connected here.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/index.js';
import { encryptSecret, decryptSecret } from '../crypto/secrets.js';
import { logActivity } from '../observability/activity.js';
import { logger } from '../logger.js';
import { createConnectHubLink } from '../auth/connect-links.js';
import { domainHealthFor, dnsVerdict, issuesOf } from '../warmup/dns-health.js';
import { parseTags } from '../accounts/tags.js';
import { NamecheapClient, type Availability, type TldPrice } from './namecheap.js';
import { PremiumInboxesClient, type PiOrder, type PiPurchase, type PiDeliveredEmail } from './premiuminboxes.js';
import { getIntegration, markIntegration, orgsWithIntegration } from './integrations.js';
import { suggestDomains, splitDomain, type Suggestion } from './names.js';
import type { Domain, ProviderOrder } from '../db/schema.js';

// Test seams: the workers and routes go through these so a test can swap the
// network clients for fakes.
export const clients = {
  namecheap: (orgId: string): NamecheapClient => {
    const cfg = getIntegration(orgId, 'namecheap');
    if (!cfg) throw new Error('Namecheap is not connected for this workspace');
    return new NamecheapClient(cfg);
  },
  premiuminboxes: (orgId: string): PremiumInboxesClient => {
    const cfg = getIntegration(orgId, 'premiuminboxes');
    if (!cfg) throw new Error('Premium Inboxes is not connected for this workspace');
    return new PremiumInboxesClient(cfg.apiToken);
  },
};

export interface Candidate extends Suggestion {
  available: boolean | null;
  premium: boolean;
  price: number | null;
  currency: string | null;
  /** Already in this workspace. */
  owned: boolean;
}

/** Suggest names for a brand and check them at the registrar. */
export async function findDomains(orgId: string, brand: string, tlds: string[], max = 40): Promise<Candidate[]> {
  const owned = new Set(listDomains(orgId).map((d) => d.domain));
  const suggestions = suggestDomains(brand, { tlds, max, exclude: owned });
  if (suggestions.length === 0) return [];
  const nc = clients.namecheap(orgId);
  let checks: Availability[] = [];
  let prices: TldPrice[] = [];
  try {
    [checks, prices] = await Promise.all([nc.check(suggestions.map((s) => s.domain)), nc.pricing([...new Set(suggestions.map((s) => s.tld))])]);
    markIntegration(orgId, 'namecheap', { ok: true });
  } catch (err) {
    markIntegration(orgId, 'namecheap', { ok: false, error: String(err) });
    throw err;
  }
  const byDomain = new Map(checks.map((c) => [c.domain, c]));
  const priceByTld = new Map(prices.map((p) => [p.tld, p]));
  return suggestions.map((s) => {
    const c = byDomain.get(s.domain);
    const p = priceByTld.get(s.tld);
    return {
      ...s,
      available: c ? c.available : null,
      premium: c?.premium ?? false,
      price: c?.premium ? c.premiumPrice : p?.price ?? null,
      currency: p?.currency ?? null,
      owned: owned.has(s.domain),
    };
  });
}

/** Check a hand-typed list instead of suggestions. */
export async function checkDomains(orgId: string, domainList: string[]): Promise<Candidate[]> {
  const nc = clients.namecheap(orgId);
  const owned = new Set(listDomains(orgId).map((d) => d.domain));
  const tlds = [...new Set(domainList.map((d) => splitDomain(d).tld))];
  const [checks, prices] = await Promise.all([nc.check(domainList), nc.pricing(tlds)]);
  const priceByTld = new Map(prices.map((p) => [p.tld, p]));
  return checks.map((c) => {
    const { sld, tld } = splitDomain(c.domain);
    const p = priceByTld.get(tld);
    return { domain: c.domain, sld, tld, shape: 'suffix' as const, available: c.available, premium: c.premium, price: c.premium ? c.premiumPrice : p?.price ?? null, currency: p?.currency ?? null, owned: owned.has(c.domain) };
  });
}

export interface PurchaseResult {
  domain: string;
  ok: boolean;
  chargedAmount?: number;
  error?: string;
}

/** Register each domain and record it; one failure does not stop the rest. */
export async function buyDomains(orgId: string, domainList: string[], tags: string[] = []): Promise<PurchaseResult[]> {
  const nc = clients.namecheap(orgId);
  const results: PurchaseResult[] = [];
  for (const domain of domainList) {
    try {
      const r = await nc.register(domain);
      if (!r.registered) throw new Error('Namecheap did not confirm the registration');
      upsertDomain(orgId, domain, {
        registrar: 'namecheap',
        status: 'purchased',
        purchasedAt: Date.now(),
        expiresAt: Date.now() + 365 * 24 * 3600_000,
        registrarJson: JSON.stringify({ domainId: r.domainId, orderId: r.orderId, transactionId: r.transactionId, chargedAmount: r.chargedAmount, whoisGuard: r.whoisGuard }),
        tagsJson: tags.length ? JSON.stringify(tags) : null,
      });
      results.push({ domain, ok: true, chargedAmount: r.chargedAmount });
      logActivity({ category: 'domains', action: 'buy', status: 'ok', orgId, detail: `${domain} for ${r.chargedAmount}` });
    } catch (err) {
      results.push({ domain, ok: false, error: String(err).slice(0, 300) });
      logActivity({ category: 'domains', action: 'buy', status: 'failed', orgId, detail: domain, error: String(err).slice(0, 300) });
    }
  }
  markIntegration(orgId, 'namecheap', results.some((r) => r.ok) || results.length === 0 ? { ok: true } : { ok: false, error: results[0]?.error ?? 'purchase failed' });
  return results;
}

/** Bring the registrar's domain list in, without touching what is already tracked. */
export async function importRegistrarDomains(orgId: string): Promise<{ imported: number; total: number }> {
  const nc = clients.namecheap(orgId);
  const remote = await nc.list();
  markIntegration(orgId, 'namecheap', { ok: true });
  const known = new Set(listDomains(orgId).map((d) => d.domain));
  let imported = 0;
  for (const d of remote) {
    if (known.has(d.domain)) {
      db.update(schema.domains).set({ expiresAt: d.expiresAt, registrar: 'namecheap', updatedAt: Date.now() }).where(and(eq(schema.domains.orgId, orgId), eq(schema.domains.domain, d.domain))).run();
      continue;
    }
    upsertDomain(orgId, d.domain, { registrar: 'namecheap', status: 'purchased', expiresAt: d.expiresAt });
    imported++;
  }
  return { imported, total: remote.length };
}

/** Domains that carry connected mailboxes but were never recorded here. */
export function adoptConnectedDomains(orgId: string): number {
  const known = new Set(listDomains(orgId).map((d) => d.domain));
  const emails = db.select({ email: schema.accounts.email }).from(schema.accounts).where(eq(schema.accounts.orgId, orgId)).all();
  let added = 0;
  for (const domain of new Set(emails.map((e) => e.email.split('@')[1] ?? '').filter(Boolean))) {
    if (known.has(domain)) continue;
    upsertDomain(orgId, domain, { registrar: 'other', status: 'connected' });
    added++;
  }
  return added;
}

function upsertDomain(
  orgId: string,
  domain: string,
  patch: Partial<Pick<Domain, 'registrar' | 'status' | 'purchasedAt' | 'expiresAt' | 'registrarJson' | 'orderId' | 'tagsJson'>>,
): void {
  const now = Date.now();
  const existing = db.select().from(schema.domains).where(and(eq(schema.domains.orgId, orgId), eq(schema.domains.domain, domain))).get();
  if (existing) {
    db.update(schema.domains).set({ ...patch, updatedAt: now }).where(eq(schema.domains.id, existing.id)).run();
  } else {
    db.insert(schema.domains).values({ id: nanoid(), orgId, domain, createdAt: now, updatedAt: now, ...patch }).run();
  }
}

export function listDomains(orgId: string): Domain[] {
  return db.select().from(schema.domains).where(eq(schema.domains.orgId, orgId)).all();
}

// ---------------------------------------------------------------------------
// Orders at Premium Inboxes
// ---------------------------------------------------------------------------

export interface OrderInput {
  domains: string[];
  emailProvider: 'google' | 'microsoft';
  inboxesPerDomain: number;
  prefixVariants: string[];
  /** One persona per domain; a domain without one uses the first. */
  personas: { domain: string; firstName: string; lastName: string }[];
  password?: string;
  insured?: boolean;
  additionalInfo?: string;
  tags?: string[];
}

export interface OrderResult {
  emails: PiDeliveredEmail[];
  issues: { reason: string }[];
  status: string;
  inboxes: { total: number; perDomain: number };
  updatedAt: string;
  workspaceName?: string;
}

/** Build the purchase body the way the provisioner wants it. Exported for tests. */
export function buildPurchase(orgId: string, input: OrderInput, hosting: PiPurchase['hosting'], defaults: { profilePictureLink?: string; masterInboxEmail?: string }): PiPurchase {
  const first = input.personas[0];
  if (!first) throw new Error('At least one persona is required');
  const hubLink = createConnectHubLink(orgId);
  const note = [
    `Please do NOT connect these mailboxes to a sequencer. Connect each one to our mail gateway (OutreachEmailMCP) through this link instead, signed in as the mailbox: ${hubLink}`,
    input.additionalInfo?.trim() ?? '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    emailProvider: input.emailProvider === 'google' ? 'Google' : 'Microsoft',
    hosting,
    domains: input.domains.join('\n'),
    numberOfInboxes: input.domains.length * input.inboxesPerDomain,
    inboxesPerDomain: input.inboxesPerDomain,
    prefixVariants: input.prefixVariants,
    emailFirstName: first.firstName,
    emailLastName: first.lastName,
    ...(input.password ? { password: input.password } : {}),
    ...(defaults.profilePictureLink ? { profilePictureLink: defaults.profilePictureLink } : {}),
    ...(defaults.masterInboxEmail ? { masterInboxEmail: defaults.masterInboxEmail } : {}),
    additionalInfo: note,
    manualPersonas: input.domains.map((domain) => {
      const p = input.personas.find((x) => x.domain === domain) ?? first;
      return { firstName: p.firstName, lastName: p.lastName, domains: [domain], prefixVariants: input.prefixVariants };
    }),
    insured: !!input.insured,
    flowStartedAt: Date.now(),
  };
}

export async function placeOrder(orgId: string, input: OrderInput): Promise<ProviderOrder> {
  const cfg = getIntegration(orgId, 'premiuminboxes');
  if (!cfg) throw new Error('Premium Inboxes is not connected for this workspace');
  if (input.domains.length === 0) throw new Error('Pick at least one domain');
  const body = buildPurchase(orgId, input, cfg.hosting, cfg.defaults);
  const pi = clients.premiuminboxes(orgId);
  const now = Date.now();
  const id = nanoid();
  const redacted = { ...body, hosting: { platform: body.hosting.platform }, password: body.password ? '(set)' : undefined };
  let externalId: string;
  try {
    externalId = await pi.purchase(body, cfg.workspaceId);
    markIntegration(orgId, 'premiuminboxes', { ok: true });
  } catch (err) {
    markIntegration(orgId, 'premiuminboxes', { ok: false, error: String(err) });
    logActivity({ category: 'domains', action: 'order', status: 'failed', orgId, detail: input.domains.join(', '), error: String(err).slice(0, 300) });
    throw err;
  }
  db.insert(schema.providerOrders)
    .values({
      id,
      orgId,
      provider: 'premiuminboxes',
      externalId,
      status: 'submitted',
      emailProvider: input.emailProvider,
      domainsJson: JSON.stringify(input.domains),
      requestJson: JSON.stringify(redacted),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  for (const domain of input.domains) {
    upsertDomain(orgId, domain, { status: 'ordered', orderId: id, tagsJson: input.tags?.length ? JSON.stringify(input.tags) : undefined });
  }
  logActivity({ category: 'domains', action: 'order', status: 'ok', orgId, detail: `${externalId}: ${input.domains.length} domain(s), ${body.numberOfInboxes} inboxes` });
  return db.select().from(schema.providerOrders).where(eq(schema.providerOrders.id, id)).get()!;
}

export function listOrders(orgId: string): ProviderOrder[] {
  return db.select().from(schema.providerOrders).where(eq(schema.providerOrders.orgId, orgId)).all().sort((a, b) => b.createdAt - a.createdAt);
}

export function orderResult(order: ProviderOrder): OrderResult | null {
  if (!order.resultEnc) return null;
  try {
    return JSON.parse(decryptSecret(order.resultEnc)) as OrderResult;
  } catch {
    return null;
  }
}

/** Mirror every order the provisioner knows about into our table, and move
 *  domains along as mailboxes get delivered and connected. */
export async function syncOrders(orgId: string): Promise<{ orders: number; delivered: number }> {
  const pi = clients.premiuminboxes(orgId);
  let remote: PiOrder[];
  try {
    remote = await pi.orders();
    markIntegration(orgId, 'premiuminboxes', { ok: true });
  } catch (err) {
    markIntegration(orgId, 'premiuminboxes', { ok: false, error: String(err) });
    throw err;
  }
  const local = listOrders(orgId);
  const byExternal = new Map(local.map((o) => [o.externalId, o]));
  const now = Date.now();
  let delivered = 0;
  for (const r of remote) {
    const emails = (r.emails ?? []).filter((e) => e && e.email);
    const result: OrderResult = {
      emails,
      issues: r.issues ?? [],
      status: r.status,
      inboxes: r.inboxes ?? { total: 0, perDomain: 0 },
      updatedAt: r.updatedAt,
      workspaceName: r.workspaceName,
    };
    const existing = byExternal.get(r._id);
    const patch = {
      status: r.status ?? 'unknown',
      resultEnc: encryptSecret(JSON.stringify(result)),
      lastCheckedAt: now,
      lastError: null,
      updatedAt: now,
      ...(emails.length ? { deliveredAt: existing?.deliveredAt ?? now } : {}),
    };
    let orderId: string;
    if (existing) {
      orderId = existing.id;
      db.update(schema.providerOrders).set(patch).where(eq(schema.providerOrders.id, existing.id)).run();
    } else {
      orderId = nanoid();
      db.insert(schema.providerOrders)
        .values({
          id: orderId,
          orgId,
          provider: 'premiuminboxes',
          externalId: r._id,
          emailProvider: String(r.emailProvider).toLowerCase() === 'microsoft' ? 'microsoft' : 'google',
          domainsJson: JSON.stringify(r.domains ?? []),
          requestJson: JSON.stringify({ importedFromProvider: true }),
          createdAt: Date.parse(r.createdAt) || now,
          ...patch,
        })
        .run();
    }
    if (emails.length) delivered++;
    // Domains: ordered → provisioned when mailboxes exist → connected when every one is in the proxy.
    const connectedEmails = new Set(
      emails.length
        ? db.select({ email: schema.accounts.email }).from(schema.accounts).where(and(eq(schema.accounts.orgId, orgId), inArray(schema.accounts.email, emails.map((e) => e.email.toLowerCase())))).all().map((a) => a.email)
        : [],
    );
    for (const domain of r.domains ?? []) {
      const mine = emails.filter((e) => e.email.toLowerCase().endsWith('@' + domain.toLowerCase()));
      const status: Domain['status'] = mine.length === 0 ? 'ordered' : mine.every((e) => connectedEmails.has(e.email.toLowerCase())) ? 'connected' : 'provisioned';
      const row = db.select().from(schema.domains).where(and(eq(schema.domains.orgId, orgId), eq(schema.domains.domain, domain.toLowerCase()))).get();
      if (row) {
        // Never regress a connected domain because the provider list lags.
        if (row.status === 'connected' && status !== 'connected') continue;
        db.update(schema.domains).set({ status, orderId, updatedAt: now }).where(eq(schema.domains.id, row.id)).run();
      } else {
        upsertDomain(orgId, domain.toLowerCase(), { registrar: 'other', status, orderId });
      }
    }
  }
  return { orders: remote.length, delivered };
}

export async function syncAllOrders(): Promise<void> {
  for (const orgId of orgsWithIntegration('premiuminboxes')) {
    try {
      await syncOrders(orgId);
    } catch (err) {
      logger.warn({ orgId, err: String(err) }, 'order sync failed');
    }
  }
}

// ---------------------------------------------------------------------------
// Read models for the page
// ---------------------------------------------------------------------------

export interface DomainRow extends Domain {
  tags: string[];
  dns: { verdict: 'ok' | 'warn' | 'bad' | 'unchecked'; issues: string[] };
  mailboxes: { connected: number; delivered: number };
  order: { id: string; externalId: string | null; status: string } | null;
}

export interface OrderRow {
  order: ProviderOrder;
  domains: string[];
  result: OrderResult | null;
  delivered: number;
  connected: number;
}

export function domainsOverview(orgId: string): { domains: DomainRow[]; orders: OrderRow[]; hubLink: string } {
  const rows = listDomains(orgId);
  const orders = listOrders(orgId);
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const accounts = db.select({ email: schema.accounts.email }).from(schema.accounts).where(eq(schema.accounts.orgId, orgId)).all();
  const connectedByDomain = new Map<string, number>();
  const connectedEmails = new Set<string>();
  for (const a of accounts) {
    connectedEmails.add(a.email.toLowerCase());
    const d = a.email.split('@')[1] ?? '';
    connectedByDomain.set(d, (connectedByDomain.get(d) ?? 0) + 1);
  }
  const deliveredByDomain = new Map<string, number>();
  const orderRows: OrderRow[] = orders.map((o) => {
    const result = orderResult(o);
    const emails = result?.emails ?? [];
    for (const e of emails) {
      const d = e.email.split('@')[1]?.toLowerCase() ?? '';
      deliveredByDomain.set(d, (deliveredByDomain.get(d) ?? 0) + 1);
    }
    let domainsList: string[] = [];
    try {
      domainsList = JSON.parse(o.domainsJson) as string[];
    } catch {
      domainsList = [];
    }
    return { order: o, domains: domainsList, result, delivered: emails.length, connected: emails.filter((e) => connectedEmails.has(e.email.toLowerCase())).length };
  });
  const health = domainHealthFor(rows.map((d) => d.domain));
  const domainsList: DomainRow[] = rows
    .map((d) => {
      const h = health.get(d.domain);
      const o = d.orderId ? orderById.get(d.orderId) : undefined;
      return {
        ...d,
        tags: parseTags(d.tagsJson),
        dns: { verdict: dnsVerdict(h), issues: issuesOf(h) },
        mailboxes: { connected: connectedByDomain.get(d.domain) ?? 0, delivered: deliveredByDomain.get(d.domain) ?? 0 },
        order: o ? { id: o.id, externalId: o.externalId, status: o.status } : null,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  return { domains: domainsList, orders: orderRows, hubLink: createConnectHubLink(orgId) };
}

/** Delivered mailboxes of one order with whether each is connected here. */
export function orderMailboxes(orgId: string, orderId: string): { order: ProviderOrder; result: OrderResult | null; emails: (PiDeliveredEmail & { connected: boolean })[] } | null {
  const order = db.select().from(schema.providerOrders).where(and(eq(schema.providerOrders.id, orderId), eq(schema.providerOrders.orgId, orgId))).get();
  if (!order) return null;
  const result = orderResult(order);
  const emails = result?.emails ?? [];
  const connected = new Set(
    emails.length
      ? db.select({ email: schema.accounts.email }).from(schema.accounts).where(and(eq(schema.accounts.orgId, orgId), inArray(schema.accounts.email, emails.map((e) => e.email.toLowerCase())))).all().map((a) => a.email.toLowerCase())
      : [],
  );
  return { order, result, emails: emails.map((e) => ({ ...e, connected: connected.has(e.email.toLowerCase()) })) };
}

/** A random, readable mailbox password for an order. */
export function generateMailboxPassword(): string {
  const words = ['maple', 'river', 'stone', 'cloud', 'ember', 'harbor', 'meadow', 'falcon', 'cedar', 'summit', 'lantern', 'orchid'];
  const pick = () => words[Math.floor(Math.random() * words.length)]!;
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  return `${cap(pick())}${cap(pick())}${Math.floor(1000 + Math.random() * 9000)}!`;
}
