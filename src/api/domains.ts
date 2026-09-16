/**
 * Domains API: what the Domains page does, for a product that embeds this
 * gateway — suggest and buy domains at the registrar, order mailboxes at the
 * provisioner, follow the orders. Mailbox passwords never leave the
 * gateway: the provisioner's delivered list is returned without them.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { orgOf, requireScope } from './plugin.js';
import {
  adoptConnectedDomains,
  checkDomains,
  clients,
  domainsOverview,
  estimateBatch,
  findDomains,
  importRegistrarDomains,
  orderMailboxes,
  orderResult,
  runBatch,
  syncOrders,
  type DomainRow,
  type OrderResult,
} from '../domains/service.js';
import { getIntegration, getIntegrationRow, integrationSource } from '../domains/integrations.js';
import { ADDRESS_PATTERNS, localParts } from '../domains/patterns.js';
import { DEFAULT_TLDS, parseDomainList } from '../domains/names.js';
import { db, schema } from '../db/index.js';
import { and, eq, inArray } from 'drizzle-orm';
import type { ProviderOrder } from '../db/schema.js';

export interface PublicOrder {
  id: string;
  externalId: string | null;
  status: string;
  emailProvider: 'google' | 'microsoft';
  domains: string[];
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  lastCheckedAt: number | null;
  lastError: string | null;
  issues: { reason: string }[];
  inboxes: { total: number; perDomain: number };
  emails: { email: string; firstName: string; lastName: string; status: string; connected: boolean }[];
}

/** An order as the API shows it: the provisioner's status and the delivered
 *  addresses, never their passwords. Exported so a test can prove that. */
export function publicOrder(order: ProviderOrder, result: OrderResult | null, connected: Set<string>): PublicOrder {
  let domains: string[] = [];
  try {
    domains = JSON.parse(order.domainsJson) as string[];
  } catch {
    domains = [];
  }
  return {
    id: order.id,
    externalId: order.externalId,
    status: order.status,
    emailProvider: order.emailProvider,
    domains,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    deliveredAt: order.deliveredAt,
    lastCheckedAt: order.lastCheckedAt,
    lastError: order.lastError,
    issues: result?.issues ?? [],
    inboxes: result?.inboxes ?? { total: 0, perDomain: 0 },
    emails: (result?.emails ?? []).map((e) => ({
      email: e.email,
      firstName: e.firstName,
      lastName: e.lastName,
      status: e.status,
      connected: connected.has(e.email.toLowerCase()),
    })),
  };
}

function connectedEmails(orgId: string, emails: string[]): Set<string> {
  if (emails.length === 0) return new Set();
  return new Set(
    db
      .select({ email: schema.accounts.email })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.orgId, orgId), inArray(schema.accounts.email, emails.map((e) => e.toLowerCase()))))
      .all()
      .map((a) => a.email.toLowerCase()),
  );
}

export function publicDomain(d: DomainRow) {
  return {
    id: d.id,
    domain: d.domain,
    registrar: d.registrar,
    status: d.status,
    purchasedAt: d.purchasedAt,
    expiresAt: d.expiresAt,
    orderId: d.orderId,
    tags: d.tags,
    platform: d.platform,
    autoRenew: d.registrarInfo.autoRenew ?? null,
    chargedAmount: d.registrarInfo.chargedAmount ?? null,
    dns: d.dns,
    mailboxes: d.mailboxes,
    order: d.order,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function integrationsView(orgId: string) {
  const nc = getIntegration(orgId, 'namecheap');
  const pi = getIntegration(orgId, 'premiuminboxes');
  const ncSource = integrationSource(orgId, 'namecheap');
  const piSource = integrationSource(orgId, 'premiuminboxes');
  const ncRow = ncSource === 'own' ? getIntegrationRow(orgId, 'namecheap') : null;
  const piRow = piSource === 'own' ? getIntegrationRow(orgId, 'premiuminboxes') : null;
  return {
    namecheap: {
      configured: !!nc,
      shared: ncSource === 'shared',
      verifiedAt: ncRow?.verifiedAt ?? null,
      lastError: ncRow?.lastError ?? null,
    },
    premiuminboxes: {
      configured: !!pi,
      shared: piSource === 'shared',
      verifiedAt: piRow?.verifiedAt ?? null,
      lastError: piRow?.lastError ?? null,
      workspaceName: pi?.workspaceName ?? null,
      defaults: pi?.defaults ?? null,
      pricePerInboxCents: pi?.pricePerInboxCents ?? 350,
    },
  };
}

const upstream = (reply: FastifyReply, err: unknown) => reply.code(502).send({ error: String(err).slice(0, 300) });

const findSchema = z.object({
  brand: z.string().max(100).optional(),
  tlds: z.array(z.string().max(16)).max(20).optional(),
  domains: z.array(z.string().max(253)).max(200).optional(),
});

const estimateSchema = z.object({
  domains: z.array(z.string().max(253)).min(1).max(200),
  inboxesPerDomain: z.coerce.number().int().min(1).max(10),
});

const batchSchema = z.object({
  domains: z.array(z.string().max(253)).min(1).max(200),
  forwardedDomain: z.string().max(253),
  emailProvider: z.enum(['google', 'microsoft']),
  inboxesPerDomain: z.coerce.number().int().min(1).max(10),
  prefixVariants: z.array(z.string().max(40)).max(20),
  personas: z.array(z.object({ domain: z.string().max(253), firstName: z.string().max(60), lastName: z.string().max(60) })).max(200),
  password: z.string().max(100).optional(),
  insured: z.boolean().optional(),
  additionalInfo: z.string().max(4000).optional(),
  tags: z.array(z.string().max(32)).max(25).optional(),
  profilePictureLink: z.string().url().optional(),
});

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export function registerDomainRoutes(app: FastifyInstance): void {
  app.get('/domains', async (req, reply) => {
    if (!requireScope(req, reply, 'read')) return;
    const orgId = orgOf(req);
    const overview = domainsOverview(orgId);
    const allEmails = overview.orders.flatMap((o) => (o.result?.emails ?? []).map((e) => e.email));
    const connected = connectedEmails(orgId, allEmails);
    const pi = getIntegration(orgId, 'premiuminboxes');
    return {
      domains: overview.domains.map(publicDomain),
      orders: overview.orders.map((o) => publicOrder(o.order, o.result, connected)),
      integrations: integrationsView(orgId),
      hubLink: overview.hubLink,
      defaultTlds: DEFAULT_TLDS,
      patterns: ADDRESS_PATTERNS,
      pricePerInboxCents: pi?.pricePerInboxCents ?? 350,
    };
  });

  app.post('/domains/find', async (req, reply) => {
    if (!requireScope(req, reply, 'accounts')) return;
    const orgId = orgOf(req);
    const body = findSchema.parse(req.body ?? {});
    if (!getIntegration(orgId, 'namecheap')) return reply.code(409).send({ error: 'Namecheap is not connected for this workspace' });
    const custom = parseDomainList((body.domains ?? []).join('\n'));
    const brand = (body.brand ?? '').trim();
    if (custom.length === 0 && !brand) return reply.code(400).send({ error: 'Provide a brand word or a list of domains to check' });
    const tlds = (body.tlds ?? []).map((t) => t.toLowerCase().replace(/^\./, '')).filter(Boolean);
    try {
      const candidates = custom.length ? await checkDomains(orgId, custom) : await findDomains(orgId, brand, tlds.length ? tlds : DEFAULT_TLDS.slice(0, 3));
      const balance = await clients.namecheap(orgId).balances().catch(() => null);
      return { candidates, balance: balance ? { available: balance.available, currency: balance.currency } : null };
    } catch (err) {
      return upstream(reply, err);
    }
  });

  app.post('/domains/estimate', async (req, reply) => {
    if (!requireScope(req, reply, 'accounts')) return;
    const body = estimateSchema.parse(req.body ?? {});
    const domains = parseDomainList(body.domains.join('\n'));
    if (domains.length === 0) return reply.code(400).send({ error: 'No valid domain in the list' });
    try {
      return await estimateBatch(orgOf(req), domains, body.inboxesPerDomain);
    } catch (err) {
      return upstream(reply, err);
    }
  });

  app.post('/domains/batch', async (req, reply) => {
    if (!requireScope(req, reply, 'accounts')) return;
    const orgId = orgOf(req);
    const body = batchSchema.parse(req.body ?? {});
    const domains = parseDomainList(body.domains.join('\n'));
    if (domains.length === 0) return reply.code(400).send({ error: 'Tick at least one domain.' });
    if (!getIntegration(orgId, 'premiuminboxes')) return reply.code(409).send({ error: 'Premium Inboxes is not connected for this workspace' });
    const personas = domains.map((domain) => {
      const p = body.personas.find((x) => x.domain.toLowerCase() === domain) ?? body.personas[0];
      return { domain, firstName: (p?.firstName ?? '').trim(), lastName: (p?.lastName ?? '').trim() };
    });
    const missing = personas.find((p) => !p.firstName || !p.lastName);
    if (missing) return reply.code(400).send({ error: `The mailboxes need a first and last name (missing for ${missing.domain}).` });
    const forwardedDomain = body.forwardedDomain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    if (!DOMAIN_RE.test(forwardedDomain)) return reply.code(400).send({ error: 'Premium Inboxes needs a forwarding domain: the website the new domains redirect to, e.g. kandidaatflow.nl.' });
    const first = personas[0]!;
    if (localParts(body.prefixVariants, first.firstName, first.lastName).length === 0) return reply.code(400).send({ error: 'Pick at least one address pattern.' });
    let result;
    try {
      result = await runBatch(orgId, {
        domains,
        forwardedDomain,
        emailProvider: body.emailProvider,
        inboxesPerDomain: body.inboxesPerDomain,
        prefixVariants: body.prefixVariants,
        personas,
        password: body.password?.trim() || undefined,
        insured: !!body.insured,
        additionalInfo: body.additionalInfo?.trim() || undefined,
        tags: body.tags,
        profilePictureLink: body.profilePictureLink,
      });
    } catch (err) {
      return upstream(reply, err);
    }
    return {
      bought: result.bought,
      order: result.order ? publicOrder(result.order, orderResult(result.order), new Set()) : null,
      orderError: result.orderError,
    };
  });

  app.post('/domains/orders/sync', async (req, reply) => {
    if (!requireScope(req, reply, 'accounts')) return;
    const orgId = orgOf(req);
    if (!getIntegration(orgId, 'premiuminboxes')) return reply.code(409).send({ error: 'Premium Inboxes is not connected for this workspace' });
    try {
      return await syncOrders(orgId);
    } catch (err) {
      return upstream(reply, err);
    }
  });

  app.post('/domains/import', async (req, reply) => {
    if (!requireScope(req, reply, 'accounts')) return;
    const orgId = orgOf(req);
    const adopted = adoptConnectedDomains(orgId);
    if (!getIntegration(orgId, 'namecheap')) return { adopted, imported: 0, total: 0 };
    try {
      const r = await importRegistrarDomains(orgId);
      return { adopted, imported: r.imported, total: r.total };
    } catch (err) {
      return upstream(reply, err);
    }
  });

  app.get<{ Params: { orderId: string } }>('/domains/orders/:orderId', async (req, reply) => {
    if (!requireScope(req, reply, 'read')) return;
    const detail = orderMailboxes(orgOf(req), req.params.orderId);
    if (!detail) return reply.code(404).send({ error: 'Unknown order' });
    return publicOrder(detail.order, detail.result, new Set(detail.emails.filter((e) => e.connected).map((e) => e.email.toLowerCase())));
  });
}
