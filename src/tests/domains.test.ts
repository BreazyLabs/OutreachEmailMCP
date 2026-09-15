import { describe, it, expect, beforeAll } from 'vitest';

process.env.MASTER_KEY = Buffer.alloc(32, 11).toString('base64');
process.env.DATA_DIR = './data-test/domains';
process.env.BASE_URL = 'http://localhost:3000';
process.env.SAAS_MODE = 'false';

const xml = (inner: string, status = 'OK') =>
  `<?xml version="1.0" encoding="utf-8"?><ApiResponse Status="${status}" xmlns="http://api.namecheap.com/xml.response"><Errors>${status === 'OK' ? '' : '<Error Number="2030280">TLD is not supported</Error>'}</Errors><CommandResponse>${inner}</CommandResponse><Server>PHX01</Server></ApiResponse>`;

const fakeFetch = (routes: (url: string, init?: RequestInit) => { status?: number; body: string; headers?: Record<string, string> }) =>
  async (url: string, init?: RequestInit) => {
    const r = routes(url, init);
    return new Response(r.body, { status: r.status ?? 200, headers: r.headers });
  };

describe('domain name suggestions', () => {
  it('wraps the brand in prefixes and suffixes across the chosen endings, never the bare brand', async () => {
    const { suggestDomains, normalizeBrand, parseDomainList } = await import('../domains/names.js');
    expect(normalizeBrand('https://www.Breazy.nl/')).toBe('breazy');
    const s = suggestDomains('breazy', { tlds: ['nl', 'com'], max: 500 });
    expect(s.some((x) => x.domain === 'getbreazy.nl')).toBe(true);
    expect(s.some((x) => x.domain === 'breazygrowth.com')).toBe(true);
    expect(s.some((x) => x.domain === 'breazy.nl')).toBe(false);
    expect(new Set(s.map((x) => x.domain)).size).toBe(s.length);
    expect(suggestDomains('breazy', { tlds: ['nl'], exclude: ['getbreazy.nl'] }).some((x) => x.domain === 'getbreazy.nl')).toBe(false);
    expect(parseDomainList('GetBreazy.nl, https://trybreazy.com/x\n bad_domain ;a.b.co')).toEqual(['getbreazy.nl', 'trybreazy.com', 'a.b.co']);
  });
});

describe('Namecheap client', () => {
  const cfg = {
    apiUser: 'u', apiKey: 'k', username: 'u', clientIp: '1.2.3.4', sandbox: true,
    contact: { firstName: 'D', lastName: 'T', address1: 'Straat 1', city: 'Amsterdam', stateProvince: 'NH', postalCode: '1000AA', country: 'NL', phone: '+31.612345678', email: 'd@x.test' },
  };

  it('parses availability, prices and a registration; surfaces API errors', async () => {
    const { NamecheapClient, NamecheapError, parseNamecheapDate } = await import('../domains/namecheap.js');
    const seen: string[] = [];
    const client = new NamecheapClient(cfg, fakeFetch((url) => {
      seen.push(url);
      const u = new URL(url);
      expect(u.origin).toBe('https://api.sandbox.namecheap.com');
      const cmd = u.searchParams.get('Command');
      if (cmd === 'namecheap.domains.check') {
        return { body: xml('<DomainCheckResult Domain="getbreazy.nl" Available="true" IsPremiumName="false" PremiumRegistrationPrice="0" /><DomainCheckResult Domain="breazy.com" Available="false" IsPremiumName="false" />') };
      }
      if (cmd === 'namecheap.users.getPricing') {
        return { body: xml('<UserGetPricingResult><ProductType Name="domains"><ProductCategory Name="register"><Product Name="nl"><Price Duration="1" DurationType="YEAR" Price="9.98" RegularPrice="12.98" YourPrice="9.98" Currency="USD" /><Price Duration="2" DurationType="YEAR" Price="19.96" YourPrice="19.96" Currency="USD" /></Product></ProductCategory></ProductType></UserGetPricingResult>') };
      }
      if (cmd === 'namecheap.domains.create') {
        expect(u.searchParams.get('RegistrantPhone')).toBe('+31.612345678');
        expect(u.searchParams.get('AuxBillingEmailAddress')).toBe('d@x.test');
        return { body: xml('<DomainCreateResult Domain="getbreazy.nl" Registered="true" ChargedAmount="9.98" DomainID="123" OrderID="456" TransactionID="789" WhoisguardEnable="true" NonRealTimeDomain="false" />') };
      }
      if (cmd === 'namecheap.domains.getList') {
        return { body: xml('<DomainGetListResult><Domain ID="1" Name="getbreazy.nl" Expires="09/15/2027" IsExpired="false" AutoRenew="true" /></DomainGetListResult><Paging><TotalItems>1</TotalItems></Paging>') };
      }
      return { body: xml('', 'ERROR') };
    }));
    const avail = await client.check(['getbreazy.nl', 'breazy.com']);
    expect(avail).toEqual([
      { domain: 'getbreazy.nl', available: true, premium: false, premiumPrice: 0 },
      { domain: 'breazy.com', available: false, premium: false, premiumPrice: null },
    ]);
    expect(await client.pricing(['nl'])).toEqual([{ tld: 'nl', price: 9.98, currency: 'USD' }]);
    const reg = await client.register('getbreazy.nl');
    expect(reg).toMatchObject({ domain: 'getbreazy.nl', registered: true, chargedAmount: 9.98, orderId: '456', whoisGuard: true });
    expect(await client.list()).toEqual([{ domain: 'getbreazy.nl', expiresAt: Date.UTC(2027, 8, 15), expired: false, autoRenew: true }]);
    await expect(client.pricing(['xyz']).then(() => client.check([]).then(() => (client as unknown as { call: (c: string, p: Record<string, string>) => Promise<unknown> }).call('nope', {})))).rejects.toBeInstanceOf(NamecheapError);
    expect(parseNamecheapDate('1/2/2030')).toBe(Date.UTC(2030, 0, 2));
  });
});

describe('Premium Inboxes client and order flow', () => {
  let orgId: string;

  beforeAll(async () => {
    const { runMigrations } = await import('../db/index.js');
    runMigrations();
    const { createOrgWithOwner } = await import('../tenancy/orgs.js');
    orgId = createOrgWithOwner({ orgName: 'Dom Co', email: 'owner@dom.test', password: 'pw-pw-pw-pw-1' }).orgId;
    const { setIntegration } = await import('../domains/integrations.js');
    setIntegration(orgId, 'premiuminboxes', {
      apiToken: 'tok',
      workspaceId: 'ws1',
      hosting: { platform: 'Namecheap', username: 'nc-user', password: 'nc-pass', namecheapBackupCodes: 'codes' },
      defaults: { emailProvider: 'Google', inboxesPerDomain: 2, prefixVariants: ['first', 'first.last'], insured: false },
    });
  });

  it('stores integration settings encrypted and reads them back', async () => {
    const { getIntegration, getIntegrationRow, mask } = await import('../domains/integrations.js');
    expect(getIntegration(orgId, 'premiuminboxes')?.hosting.username).toBe('nc-user');
    expect(getIntegrationRow(orgId, 'premiuminboxes')?.configEnc).not.toContain('nc-pass');
    expect(mask('4hsi40SXVZkyx8sPJablsXX11eAtTf1c')).toMatch(/^4hs•+1c$/);
  });

  it('builds a purchase that keeps the mailboxes away from sequencers and points at our onboarding link', async () => {
    const { buildPurchase } = await import('../domains/service.js');
    const body = buildPurchase(orgId, {
      domains: ['getbreazy.nl', 'trybreazy.nl'],
      emailProvider: 'google',
      inboxesPerDomain: 2,
      prefixVariants: ['first', 'first.last'],
      personas: [{ domain: 'getbreazy.nl', firstName: 'Dennis', lastName: 'Jansen' }],
      password: 'Pw1234!',
      insured: true,
    }, { platform: 'Namecheap', username: 'nc-user', password: 'nc-pass' }, {});
    expect(body.emailProvider).toBe('Google');
    expect(body.domains).toBe('getbreazy.nl\ntrybreazy.nl');
    expect(body.numberOfInboxes).toBe(4);
    expect(body.manualPersonas).toEqual([
      { firstName: 'Dennis', lastName: 'Jansen', domains: ['getbreazy.nl'], prefixVariants: ['first', 'first.last'] },
      { firstName: 'Dennis', lastName: 'Jansen', domains: ['trybreazy.nl'], prefixVariants: ['first', 'first.last'] },
    ]);
    expect(body.additionalInfo).toMatch(/do NOT connect these mailboxes to a sequencer/);
    expect(body.additionalInfo).toContain('http://localhost:3000/');
    expect(body).not.toHaveProperty('sequencer');
  });

  it('places an order, mirrors the provider status, and moves domains along as mailboxes are delivered and connected', async () => {
    const { PremiumInboxesClient } = await import('../domains/premiuminboxes.js');
    const service = await import('../domains/service.js');
    const { db, schema } = await import('../db/index.js');
    const { eq, and } = await import('drizzle-orm');
    let stage = 0;
    const calls: { path: string; headers: Record<string, string> }[] = [];
    const client = new PremiumInboxesClient('tok', fakeFetch((url, init) => {
      const path = url.replace('https://api.premiuminboxes.com/api', '');
      calls.push({ path, headers: (init?.headers ?? {}) as Record<string, string> });
      if (path === '/client/purchase') return { body: '"ord_1"' };
      if (path === '/client/order') {
        const emails = stage >= 1 ? [
          { firstName: 'Dennis', lastName: 'Jansen', email: 'dennis@getbreazy.nl', password: 'p1', status: 'active' },
          { firstName: 'Dennis', lastName: 'Jansen', email: 'dennis.jansen@getbreazy.nl', password: 'p2', status: 'active' },
        ] : [];
        return { body: JSON.stringify({ data: [{ _id: 'ord_1', status: stage >= 1 ? 'Delivered' : 'Received & Data Validation', emailProvider: 'Google', domains: ['getbreazy.nl'], prefixVariants: [], issues: [], inboxes: { total: 2, perDomain: 2 }, emails, createdAt: '2026-09-15T10:00:00Z', updatedAt: '2026-09-15T10:00:00Z', workspaceName: 'Dom Co' },
          { _id: 'ord_other', status: 'Delivered', emailProvider: 'Microsoft', domains: ['other.test'], prefixVariants: [], issues: [{ reason: 'DNS access denied' }], inboxes: { total: 1, perDomain: 1 }, emails: [{ firstName: 'A', lastName: 'B', email: 'a@other.test', password: 'x', status: 'active' }], createdAt: '2026-09-10T10:00:00Z', updatedAt: '2026-09-11T10:00:00Z' }] }) };
      }
      return { status: 404, body: '{"message":"nope"}' };
    }));
    service.clients.premiuminboxes = () => client;

    const now = Date.now();
    db.insert(schema.domains).values({ id: 'd1', orgId, domain: 'getbreazy.nl', registrar: 'namecheap', status: 'purchased', createdAt: now, updatedAt: now }).run();
    const order = await service.placeOrder(orgId, {
      domains: ['getbreazy.nl'], emailProvider: 'google', inboxesPerDomain: 2, prefixVariants: ['first', 'first.last'],
      personas: [{ domain: 'getbreazy.nl', firstName: 'Dennis', lastName: 'Jansen' }], tags: ['batch-1'],
    });
    expect(order.externalId).toBe('ord_1');
    expect(calls[0]?.headers['x-workspace-id']).toBe('ws1');
    expect(calls[0]?.headers['x-api-token']).toBe('tok');
    expect(JSON.parse(order.requestJson).hosting).toEqual({ platform: 'Namecheap' }); // secrets never stored in the request mirror
    const dom = () => db.select().from(schema.domains).where(and(eq(schema.domains.orgId, orgId), eq(schema.domains.domain, 'getbreazy.nl'))).get()!;
    expect(dom().status).toBe('ordered');
    expect(dom().tagsJson).toBe('["batch-1"]');

    // Nothing delivered yet: status mirrored, the foreign order imported.
    let r = await service.syncOrders(orgId);
    expect(r).toEqual({ orders: 2, delivered: 1 });
    expect(service.listOrders(orgId).map((o) => o.externalId).sort()).toEqual(['ord_1', 'ord_other']);
    expect(dom().status).toBe('ordered');
    expect(service.domainsOverview(orgId).domains.find((d) => d.domain === 'other.test')?.status).toBe('provisioned');

    // Delivered: provisioned, mailboxes visible with passwords, none connected.
    stage = 1;
    r = await service.syncOrders(orgId);
    expect(dom().status).toBe('provisioned');
    const detail = service.orderMailboxes(orgId, order.id)!;
    expect(detail.emails.map((e) => [e.email, e.connected])).toEqual([['dennis@getbreazy.nl', false], ['dennis.jansen@getbreazy.nl', false]]);
    expect(detail.order.resultEnc).not.toContain('p1');

    // Both mailboxes connected here: the domain is done.
    for (const email of ['dennis@getbreazy.nl', 'dennis.jansen@getbreazy.nl']) {
      db.insert(schema.accounts).values({ id: 'acc-' + email, orgId, provider: 'google', email, displayName: null, status: 'active', createdAt: now, updatedAt: now }).run();
    }
    await service.syncOrders(orgId);
    expect(dom().status).toBe('connected');
    const overview = service.domainsOverview(orgId);
    expect(overview.orders.find((o) => o.order.externalId === 'ord_1')).toMatchObject({ delivered: 2, connected: 2 });
    expect(overview.domains.find((d) => d.domain === 'getbreazy.nl')?.mailboxes).toEqual({ connected: 2, delivered: 2 });
  });

  it('turns a 429 into a readable error', async () => {
    const { PremiumInboxesClient, PremiumInboxesError } = await import('../domains/premiuminboxes.js');
    const client = new PremiumInboxesClient('tok', fakeFetch(() => ({ status: 429, body: '{"name":"TooManyRequestsError"}', headers: { 'retry-after': '17' } })));
    await expect(client.workspaces()).rejects.toThrow(/retry after 17s/);
    await expect(client.workspaces()).rejects.toBeInstanceOf(PremiumInboxesError);
  });
});
