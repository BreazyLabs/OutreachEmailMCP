/**
 * Domains page: buy at the registrar, order mailboxes at the provisioner,
 * follow the order until the mailboxes are connected. Plus the settings
 * for both integrations.
 */

import type { FastifyInstance } from 'fastify';
import { guard, guardPost, baseLocals } from './helpers.js';
import {
  findDomains,
  checkDomains,
  buyDomains,
  importRegistrarDomains,
  adoptConnectedDomains,
  placeOrder,
  syncOrders,
  domainsOverview,
  orderMailboxes,
  generateMailboxPassword,
  clients,
  type Candidate,
} from '../domains/service.js';
import { getIntegration, getIntegrationRow, setIntegration, markIntegration, deleteIntegration, mask, type PremiumInboxesConfig } from '../domains/integrations.js';
import { DEFAULT_TLDS, parseDomainList } from '../domains/names.js';
import { splitTagInput } from '../accounts/tags.js';
import { NamecheapClient, type NamecheapConfig } from '../domains/namecheap.js';
import { PremiumInboxesClient } from '../domains/premiuminboxes.js';
import type { SessionContext } from './session.js';
import type { FastifyRequest } from 'fastify';

type Body = Record<string, unknown>;
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v)).trim();
const list = (v: unknown): string[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const PAGE = '/ui/domains';
const back = (kind: 'notice' | 'error', text: string, panel = '') => `${PAGE}?${kind}=${encodeURIComponent(text)}${panel ? `&panel=${panel}` : ''}`;

function pageLocals(req: FastifyRequest, session: SessionContext, extra: Record<string, unknown> = {}) {
  const orgId = session.org.id;
  const nc = getIntegration(orgId, 'namecheap');
  const pi = getIntegration(orgId, 'premiuminboxes');
  const ncRow = getIntegrationRow(orgId, 'namecheap');
  const piRow = getIntegrationRow(orgId, 'premiuminboxes');
  const overview = domainsOverview(orgId);
  const orderMailboxesById = Object.fromEntries(overview.orders.map((o) => [o.order.id, orderMailboxes(orgId, o.order.id)?.emails ?? []]));
  return {
    ...baseLocals(req, session),
    page: 'domains',
    panel: (req.query as { panel?: string }).panel ?? '',
    ...overview,
    orderMailboxesById,
    integrations: {
      namecheap: nc
        ? { configured: true, verifiedAt: ncRow?.verifiedAt ?? null, lastError: ncRow?.lastError ?? null, apiUser: nc.apiUser, username: nc.username, clientIp: nc.clientIp, sandbox: !!nc.sandbox, apiKeyMasked: mask(nc.apiKey), contact: nc.contact }
        : { configured: false, verifiedAt: null, lastError: null, apiUser: '', username: '', clientIp: '', sandbox: false, apiKeyMasked: '', contact: null },
      premiuminboxes: pi
        ? { configured: true, verifiedAt: piRow?.verifiedAt ?? null, lastError: piRow?.lastError ?? null, tokenMasked: mask(pi.apiToken), workspaceId: pi.workspaceId, knownWorkspaces: pi.knownWorkspaces ?? [], hosting: { ...pi.hosting, password: mask(pi.hosting.password), namecheapBackupCodes: pi.hosting.namecheapBackupCodes ? '(set)' : '' }, defaults: pi.defaults }
        : { configured: false, verifiedAt: null, lastError: null, tokenMasked: '', workspaceId: null, knownWorkspaces: [], hosting: { platform: 'Namecheap', username: '', password: '', namecheapBackupCodes: '' }, defaults: { emailProvider: 'Google', inboxesPerDomain: 2, prefixVariants: ['first', 'first.last'], insured: false } },
    },
    defaultTlds: DEFAULT_TLDS,
    candidates: null as Candidate[] | null,
    findInput: { brand: '', tlds: DEFAULT_TLDS.slice(0, 3), custom: '' },
    suggestedPassword: generateMailboxPassword(),
    ...extra,
  };
}

export function registerDomainsUiRoutes(app: FastifyInstance): void {
  app.get('/ui/domains', async (req, reply) => {
    const session = guard(req, reply);
    if (!session) return;
    return reply.view('domains.ejs', pageLocals(req, session));
  });

  app.post<{ Body: Body }>('/ui/domains/find', async (req, reply) => {
    const session = guardPost(req, reply);
    if (!session) return;
    const body = req.body ?? {};
    const brand = str(body.brand);
    const tlds = list(body.tlds).map((t) => t.toLowerCase());
    const custom = parseDomainList(str(body.custom));
    try {
      const candidates = custom.length ? await checkDomains(session.org.id, custom) : await findDomains(session.org.id, brand, tlds);
      if (candidates.length === 0) return reply.redirect(back('error', 'Type a brand word or a list of domains to check.', 'find'));
      return reply.view('domains.ejs', pageLocals(req, session, { candidates, panel: 'find', findInput: { brand, tlds, custom: custom.join('\n') } }));
    } catch (err) {
      return reply.redirect(back('error', `Namecheap: ${String(err).slice(0, 300)}`, 'find'));
    }
  });

  app.post<{ Body: Body }>('/ui/domains/buy', async (req, reply) => {
    const session = guardPost(req, reply);
    if (!session) return;
    const domains = parseDomainList(list(req.body?.domains).join('\n'));
    if (domains.length === 0) return reply.redirect(back('error', 'Tick at least one available domain to buy.', 'find'));
    try {
      const results = await buyDomains(session.org.id, domains, splitTagInput(str(req.body?.tags)));
      const ok = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      const spent = ok.reduce((n, r) => n + (r.chargedAmount ?? 0), 0);
      const text = `${ok.length} domain${ok.length === 1 ? '' : 's'} registered${spent ? ` for ${spent.toFixed(2)}` : ''}.${failed.length ? ` ${failed.length} failed: ${failed[0]?.domain}: ${failed[0]?.error}` : ''}`;
      return reply.redirect(back(ok.length ? 'notice' : 'error', text));
    } catch (err) {
      return reply.redirect(back('error', String(err).slice(0, 300)));
    }
  });

  app.post('/ui/domains/import', async (req, reply) => {
    const session = guardPost(req, reply);
    if (!session) return;
    try {
      const adopted = adoptConnectedDomains(session.org.id);
      let text = `${adopted} domain${adopted === 1 ? '' : 's'} adopted from connected mailboxes`;
      if (getIntegration(session.org.id, 'namecheap')) {
        const r = await importRegistrarDomains(session.org.id);
        text += `, ${r.imported} imported from Namecheap (${r.total} there)`;
      }
      return reply.redirect(back('notice', text + '.'));
    } catch (err) {
      return reply.redirect(back('error', `Import failed: ${String(err).slice(0, 300)}`));
    }
  });

  app.post<{ Body: Body }>('/ui/domains/orders', async (req, reply) => {
    const session = guardPost(req, reply);
    if (!session) return;
    const body = req.body ?? {};
    const domains = parseDomainList(list(body.domains).join('\n'));
    const defaultFirst = str(body.defaultFirst);
    const defaultLast = str(body.defaultLast);
    const personas = domains.map((d) => {
      const key = d.replace(/[^a-z0-9]/g, '_');
      return { domain: d, firstName: str(body[`first_${key}`]) || defaultFirst, lastName: str(body[`last_${key}`]) || defaultLast };
    });
    const missing = personas.filter((p) => !p.firstName || !p.lastName);
    if (missing.length) return reply.redirect(back('error', `Every domain needs a first and last name (missing for ${missing[0]?.domain}).`, 'order'));
    try {
      const order = await placeOrder(session.org.id, {
        domains,
        emailProvider: str(body.emailProvider) === 'microsoft' ? 'microsoft' : 'google',
        inboxesPerDomain: Math.max(1, Math.min(10, Number(body.inboxesPerDomain) || 1)),
        prefixVariants: splitTagInput(str(body.prefixVariants)),
        personas,
        password: str(body.password) || undefined,
        insured: !!body.insured,
        additionalInfo: str(body.additionalInfo) || undefined,
        tags: splitTagInput(str(body.tags)),
      });
      return reply.redirect(back('notice', `Order ${order.externalId} placed at Premium Inboxes for ${domains.length} domain${domains.length === 1 ? '' : 's'}. Progress is checked every 10 minutes.`));
    } catch (err) {
      return reply.redirect(back('error', `Order failed: ${String(err).slice(0, 300)}`, 'order'));
    }
  });

  app.post('/ui/domains/orders/sync', async (req, reply) => {
    const session = guardPost(req, reply);
    if (!session) return;
    try {
      const r = await syncOrders(session.org.id);
      return reply.redirect(back('notice', `${r.orders} order${r.orders === 1 ? '' : 's'} checked, ${r.delivered} with mailboxes delivered.`));
    } catch (err) {
      return reply.redirect(back('error', `Sync failed: ${String(err).slice(0, 300)}`));
    }
  });

  // ---- integrations --------------------------------------------------------
  app.post<{ Body: Body }>('/ui/integrations/namecheap', async (req, reply) => {
    const session = guardPost(req, reply);
    if (!session) return;
    const body = req.body ?? {};
    const current = getIntegration(session.org.id, 'namecheap');
    if (body.delete) {
      deleteIntegration(session.org.id, 'namecheap');
      return reply.redirect(back('notice', 'Namecheap disconnected.', 'integrations'));
    }
    const cfg: NamecheapConfig = {
      apiUser: str(body.apiUser),
      apiKey: str(body.apiKey) || current?.apiKey || '',
      username: str(body.username) || str(body.apiUser),
      clientIp: str(body.clientIp),
      sandbox: !!body.sandbox,
      contact: {
        firstName: str(body.c_firstName),
        lastName: str(body.c_lastName),
        organization: str(body.c_organization) || undefined,
        address1: str(body.c_address1),
        city: str(body.c_city),
        stateProvince: str(body.c_stateProvince),
        postalCode: str(body.c_postalCode),
        country: str(body.c_country).toUpperCase(),
        phone: str(body.c_phone),
        email: str(body.c_email),
      },
    };
    const required: [string, string][] = [['API user', cfg.apiUser], ['API key', cfg.apiKey], ['client IP', cfg.clientIp]];
    const miss = required.find(([, v]) => !v);
    if (miss) return reply.redirect(back('error', `Namecheap: ${miss[0]} is required.`, 'integrations'));
    // A blank contact means "use the account's default address", the way the
    // Namecheap site itself fills the registrant in.
    let contactNote = '';
    if (!cfg.contact.firstName && !cfg.contact.lastName) {
      try {
        const fromBook = await new NamecheapClient(cfg).defaultContact();
        if (fromBook) {
          cfg.contact = fromBook;
          contactNote = ` Registrant taken from the account's address book: ${fromBook.firstName} ${fromBook.lastName}, ${fromBook.city}.`;
        }
      } catch (err) {
        setIntegration(session.org.id, 'namecheap', cfg);
        markIntegration(session.org.id, 'namecheap', { ok: false, error: String(err) });
        return reply.redirect(back('error', `Saved, but Namecheap did not answer: ${String(err).slice(0, 300)}`, 'integrations'));
      }
    }
    const contactRequired: [string, string][] = [['first name', cfg.contact.firstName], ['last name', cfg.contact.lastName], ['address', cfg.contact.address1], ['city', cfg.contact.city], ['postal code', cfg.contact.postalCode], ['country', cfg.contact.country], ['phone', cfg.contact.phone], ['email', cfg.contact.email]];
    const missC = contactRequired.find(([, v]) => !v);
    if (missC) return reply.redirect(back('error', `Namecheap registrant: ${missC[0]} is required (the address book had no default to copy).`, 'integrations'));
    if (!/^\+\d{1,3}\.\d{4,}$/.test(cfg.contact.phone)) return reply.redirect(back('error', 'Namecheap wants the phone as +CC.number, e.g. +31.612345678', 'integrations'));
    setIntegration(session.org.id, 'namecheap', cfg);
    try {
      const prices = await new NamecheapClient(cfg).pricing(['com']);
      markIntegration(session.org.id, 'namecheap', { ok: true });
      return reply.redirect(back('notice', `Namecheap connected${prices[0] ? ` (.com is ${prices[0].price} ${prices[0].currency} a year)` : ''}.${contactNote}`, 'integrations'));
    } catch (err) {
      markIntegration(session.org.id, 'namecheap', { ok: false, error: String(err) });
      return reply.redirect(back('error', `Saved, but the test call failed: ${String(err).slice(0, 300)}`, 'integrations'));
    }
  });

  app.post<{ Body: Body }>('/ui/integrations/premiuminboxes', async (req, reply) => {
    const session = guardPost(req, reply);
    if (!session) return;
    const body = req.body ?? {};
    const current = getIntegration(session.org.id, 'premiuminboxes');
    if (body.delete) {
      deleteIntegration(session.org.id, 'premiuminboxes');
      return reply.redirect(back('notice', 'Premium Inboxes disconnected.', 'integrations'));
    }
    const cfg: PremiumInboxesConfig = {
      apiToken: str(body.apiToken) || current?.apiToken || '',
      workspaceId: str(body.workspaceId) || null,
      knownWorkspaces: current?.knownWorkspaces ?? [],
      hosting: {
        platform: str(body.h_platform) || 'Namecheap',
        username: str(body.h_username) || current?.hosting.username || undefined,
        password: str(body.h_password) || current?.hosting.password || undefined,
        namecheapBackupCodes: str(body.h_backupCodes) || current?.hosting.namecheapBackupCodes || undefined,
        namecheapAccessTutorial: 'Yes - I reviewed the tutorial and am submitting the access information in requested format.',
        goDaddyAccountName: str(body.h_goDaddyAccountName) || current?.hosting.goDaddyAccountName || undefined,
      },
      defaults: {
        emailProvider: str(body.d_emailProvider) === 'Microsoft' ? 'Microsoft' : 'Google',
        inboxesPerDomain: Math.max(1, Math.min(10, Number(body.d_inboxesPerDomain) || 2)),
        prefixVariants: splitTagInput(str(body.d_prefixVariants)) .length ? splitTagInput(str(body.d_prefixVariants)) : ['first', 'first.last'],
        profilePictureLink: str(body.d_profilePictureLink) || undefined,
        masterInboxEmail: str(body.d_masterInboxEmail) || undefined,
        insured: !!body.d_insured,
      },
    };
    if (!cfg.apiToken) return reply.redirect(back('error', 'Premium Inboxes: the API token is required.', 'integrations'));
    try {
      const workspaces = await new PremiumInboxesClient(cfg.apiToken).workspaces();
      cfg.knownWorkspaces = workspaces.map((w) => ({ id: w.id, name: w.name }));
      cfg.workspaceName = workspaces.find((w) => w.id === cfg.workspaceId)?.name ?? null;
      setIntegration(session.org.id, 'premiuminboxes', cfg);
      markIntegration(session.org.id, 'premiuminboxes', { ok: true });
      return reply.redirect(back('notice', `Premium Inboxes connected: ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'} visible.`, 'integrations'));
    } catch (err) {
      setIntegration(session.org.id, 'premiuminboxes', cfg);
      markIntegration(session.org.id, 'premiuminboxes', { ok: false, error: String(err) });
      return reply.redirect(back('error', `Saved, but the test call failed: ${String(err).slice(0, 300)}`, 'integrations'));
    }
  });

  // Exposed for a quick check from the page: is the token still good?
  app.post('/ui/integrations/premiuminboxes/test', async (req, reply) => {
    const session = guardPost(req, reply);
    if (!session) return;
    try {
      const ws = await clients.premiuminboxes(session.org.id).workspaces();
      markIntegration(session.org.id, 'premiuminboxes', { ok: true });
      return reply.redirect(back('notice', `Premium Inboxes answers: ${ws.map((w) => w.name).join(', ') || 'no workspaces'}.`, 'integrations'));
    } catch (err) {
      markIntegration(session.org.id, 'premiuminboxes', { ok: false, error: String(err) });
      return reply.redirect(back('error', String(err).slice(0, 300), 'integrations'));
    }
  });
}
