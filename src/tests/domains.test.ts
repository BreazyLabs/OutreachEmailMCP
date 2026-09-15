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
      forwardedDomain: 'breazy.nl',
      emailProvider: 'google',
      inboxesPerDomain: 2,
      prefixVariants: ['first', 'first.last'],
      personas: [{ domain: 'getbreazy.nl', firstName: 'Dennis', lastName: 'Jansen' }],
      password: 'Pw1234!',
      insured: true,
    }, { platform: 'Namecheap', username: 'nc-user', password: 'nc-pass' }, {});
    expect(body.emailProvider).toBe('Google');
    expect(body.forwardedDomain).toBe('breazy.nl');
    expect(body.domains).toBe('getbreazy.nl\ntrybreazy.nl');
    expect(body.numberOfInboxes).toBe(4);
    expect(body.prefixVariants).toEqual(['dennis', 'dennis.jansen']);
    expect(body.manualPersonas).toEqual([
      { firstName: 'Dennis', lastName: 'Jansen', domains: ['getbreazy.nl'], prefixVariants: ['dennis', 'dennis.jansen'] },
      { firstName: 'Dennis', lastName: 'Jansen', domains: ['trybreazy.nl'], prefixVariants: ['dennis', 'dennis.jansen'] },
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
      domains: ['getbreazy.nl'], forwardedDomain: 'breazy.nl', emailProvider: 'google', inboxesPerDomain: 2, prefixVariants: ['first', 'first.last'],
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

describe('Namecheap address book', () => {
  it('reads the default address as the registrant contact', async () => {
    const { NamecheapClient } = await import('../domains/namecheap.js');
    const cfg = { apiUser: 'u', apiKey: 'k', username: 'u', clientIp: '1.2.3.4', contact: { firstName: '', lastName: '', address1: '', city: '', stateProvince: '', postalCode: '', country: '', phone: '', email: '' } };
    const client = new NamecheapClient(cfg, fakeFetch((url) => {
      const cmd = new URL(url).searchParams.get('Command');
      if (cmd === 'namecheap.users.address.getList') return { body: xml('<AddressGetListResult><List AddressId="7" AddressName="Home" IsDefault="false" /><List AddressId="9" AddressName="Business" IsDefault="true" /></AddressGetListResult>') };
      if (cmd === 'namecheap.users.address.getInfo') {
        expect(new URL(url).searchParams.get('AddressId')).toBe('9');
        return { body: xml('<GetAddressInfoResult><AddressId>9</AddressId><FirstName>Daniel</FirstName><LastName>T</LastName><Organization>Breazy</Organization><Address1>Straat 1</Address1><City>Amsterdam</City><StateProvince>NH</StateProvince><Zip>1000AA</Zip><Country>NL</Country><Phone>+31.612345678</Phone><EmailAddress>d@x.test</EmailAddress></GetAddressInfoResult>') };
      }
      return { body: xml('', 'ERROR') };
    }));
    expect(await client.defaultContact()).toEqual({ firstName: 'Daniel', lastName: 'T', organization: 'Breazy', address1: 'Straat 1', city: 'Amsterdam', stateProvince: 'NH', postalCode: '1000AA', country: 'NL', phone: '+31.612345678', email: 'd@x.test' });
  });
});

describe('address patterns and one-click batches', () => {
  it('renders patterns into the literal local parts the provisioner expects', async () => {
    const { localParts, renderPattern } = await import('../domains/patterns.js');
    expect(localParts(['first', 'first.last', 'f.last', 'first.l', 'flast', 'firstlast', 'last'], 'Dave', 'Spies')).toEqual(['dave', 'dave.spies', 'd.spies', 'dave.s', 'dspies', 'davespies', 'spies']);
    expect(localParts(['first', 'first.last'], 'Dennis', '')).toEqual(['dennis']);
    expect(renderPattern('first.last', 'José', 'van Empelen')).toBe('jose.vanempelen');
    expect(localParts(['custom.part'], 'A', 'B')).toEqual(['custompart']);
  });

  it('buys the new domains, skips the owned ones, and orders on everything that succeeded', async () => {
    const service = await import('../domains/service.js');
    const { NamecheapClient } = await import('../domains/namecheap.js');
    const { PremiumInboxesClient } = await import('../domains/premiuminboxes.js');
    const { db, schema } = await import('../db/index.js');
    const { eq, and } = await import('drizzle-orm');
    const { createOrgWithOwner } = await import('../tenancy/orgs.js');
    const { setIntegration, getIntegration } = await import('../domains/integrations.js');
    const orgId = createOrgWithOwner({ orgName: 'Batch Co', email: 'owner@batch.test', password: 'pw-pw-pw-pw-1' }).orgId;
    setIntegration(orgId, 'premiuminboxes', { apiToken: 't', workspaceId: null, hosting: { platform: 'Namecheap' }, defaults: { emailProvider: 'Google', inboxesPerDomain: 2, prefixVariants: ['first'], insured: false } });
    const ncCfg = { apiUser: 'u', apiKey: 'k', username: 'u', clientIp: '1.2.3.4', contact: { firstName: 'D', lastName: 'T', address1: 'S 1', city: 'A', stateProvince: 'NH', postalCode: '1', country: 'NL', phone: '+31.612345678', email: 'd@x.test' } };
    let purchaseBody: Record<string, unknown> | null = null;
    service.clients.namecheap = () => new NamecheapClient(ncCfg, fakeFetch((url) => {
      const u = new URL(url);
      const cmd = u.searchParams.get('Command');
      if (cmd === 'namecheap.users.getPricing') return { body: xml('<UserGetPricingResult><ProductType Name="domains"><ProductCategory Name="register"><Product Name="nl"><Price Duration="1" DurationType="YEAR" Price="7.48" YourPrice="7.48" Currency="USD" /></Product></ProductCategory></ProductType></UserGetPricingResult>') };
      if (cmd === 'namecheap.domains.create') {
        const d = u.searchParams.get('DomainName')!;
        if (d === 'bad.nl') return { body: xml('', 'ERROR') };
        return { body: xml(`<DomainCreateResult Domain="${d}" Registered="true" ChargedAmount="7.48" DomainID="1" OrderID="2" TransactionID="3" WhoisguardEnable="true" />`) };
      }
      return { body: xml('', 'ERROR') };
    }));
    service.clients.premiuminboxes = () => new PremiumInboxesClient('t', fakeFetch((url, init) => {
      if (url.endsWith('/client/purchase')) { purchaseBody = JSON.parse(String(init?.body)); return { body: '"ord_b"' }; }
      if (url.endsWith('/client/subscription')) return { body: JSON.stringify({ data: [{ _id: 's', status: 'Active', price: 700, discount: 0, items: [{ id: 'plan', type: 'plan', quantity: 2, unitPrice: 350, price: 700 }] }] }) };
      return { body: JSON.stringify({ data: [] }) };
    }));
    const now = Date.now();
    db.insert(schema.domains).values({ id: 'owned1', orgId, domain: 'owned.nl', registrar: 'namecheap', status: 'purchased', createdAt: now, updatedAt: now }).run();

    expect(await service.learnInboxPrice(orgId)).toBe(350);
    expect(getIntegration(orgId, 'premiuminboxes')?.pricePerInboxCents).toBe(350);
    const est = await service.estimateBatch(orgId, ['owned.nl', 'new.nl', 'bad.nl'], 2);
    expect(est.domains.map((d) => [d.domain, d.owned, d.price])).toEqual([['owned.nl', true, null], ['new.nl', false, 7.48], ['bad.nl', false, 7.48]]);
    expect(est).toMatchObject({ domainTotal: 14.96, inboxes: 6, pricePerInboxCents: 350, inboxTotalCents: 2100 });

    const r = await service.runBatch(orgId, {
      domains: ['owned.nl', 'new.nl', 'bad.nl'], forwardedDomain: 'main.nl', emailProvider: 'google', inboxesPerDomain: 2, prefixVariants: ['first', 'first.last'],
      personas: ['owned.nl', 'new.nl', 'bad.nl'].map((domain) => ({ domain, firstName: 'Dave', lastName: 'Spies' })), tags: ['b1'], profilePictureLink: 'https://x.test/p.png',
    });
    expect(r.bought.map((b) => [b.domain, b.ok])).toEqual([['new.nl', true], ['bad.nl', false]]);
    expect(r.order?.externalId).toBe('ord_b');
    expect(r.orderError).toBeNull();
    expect(purchaseBody).toMatchObject({ domains: 'owned.nl\nnew.nl', numberOfInboxes: 4, prefixVariants: ['dave', 'dave.spies'], profilePictureLink: 'https://x.test/p.png' });
    expect(String((purchaseBody as unknown as Record<string, unknown>).additionalInfo)).toMatch(/access you already have on file/);
    const status = (d: string) => db.select().from(schema.domains).where(and(eq(schema.domains.orgId, orgId), eq(schema.domains.domain, d))).get()?.status;
    expect([status('owned.nl'), status('new.nl'), status('bad.nl')]).toEqual(['ordered', 'ordered', undefined]);
    expect(service.domainsOverview(orgId).domains.every((d) => d.platform)).toBe(true);
  });
});

describe('Namecheap registration without WhoisGuard', () => {
  it('retries a TLD that refuses WhoisGuard, and gives up on any other error', async () => {
    const { NamecheapClient } = await import('../domains/namecheap.js');
    const cfg = { apiUser: 'u', apiKey: 'k', username: 'u', clientIp: '1.2.3.4', contact: { firstName: 'D', lastName: 'T', address1: 'S 1', city: 'A', stateProvince: 'NH', postalCode: '1', country: 'NL', phone: '+31.612345678', email: 'd@x.test' } };
    const attempts: string[] = [];
    const client = new NamecheapClient(cfg, fakeFetch((url) => {
      const u = new URL(url);
      attempts.push(u.searchParams.get('AddFreeWhoisguard')!);
      if (u.searchParams.get('AddFreeWhoisguard') === 'yes') {
        return { body: `<?xml version="1.0"?><ApiResponse Status="ERROR"><Errors><Error Number="2011170">This TLD 'nl' does not support adding or enabling Free whoisguard, domain: x.nl</Error></Errors></ApiResponse>` };
      }
      return { body: xml('<DomainCreateResult Domain="x.nl" Registered="true" ChargedAmount="7.48" DomainID="1" OrderID="2" TransactionID="3" WhoisguardEnable="false" />') };
    }));
    const r = await client.register('x.nl');
    expect(attempts).toEqual(['yes', 'no']);
    expect(r).toMatchObject({ registered: true, whoisGuard: false });
    const failing = new NamecheapClient(cfg, fakeFetch(() => ({ body: `<?xml version="1.0"?><ApiResponse Status="ERROR"><Errors><Error Number="2030280">Insufficient funds</Error></Errors></ApiResponse>` })));
    await expect(failing.register('y.nl')).rejects.toThrow(/Insufficient funds/);
  });
});

describe('Namecheap balance guard', () => {
  it('reads the balance and refuses a batch the balance cannot cover before buying anything', async () => {
    const service = await import('../domains/service.js');
    const { NamecheapClient } = await import('../domains/namecheap.js');
    const { createOrgWithOwner } = await import('../tenancy/orgs.js');
    const { setIntegration } = await import('../domains/integrations.js');
    const orgId = createOrgWithOwner({ orgName: 'Funds Co', email: 'owner@funds.test', password: 'pw-pw-pw-pw-1' }).orgId;
    setIntegration(orgId, 'premiuminboxes', { apiToken: 't', workspaceId: null, hosting: { platform: 'Namecheap' }, defaults: { emailProvider: 'Google', inboxesPerDomain: 1, prefixVariants: ['first'], insured: false } });
    const cfg = { apiUser: 'u', apiKey: 'k', username: 'u', clientIp: '1.2.3.4', contact: { firstName: 'D', lastName: 'T', address1: 'S 1', city: 'A', stateProvince: 'NH', postalCode: '1', country: 'NL', phone: '+31.612345678', email: 'd@x.test' } };
    let creates = 0;
    service.clients.namecheap = () => new NamecheapClient(cfg, fakeFetch((url) => {
      const cmd = new URL(url).searchParams.get('Command');
      if (cmd === 'namecheap.users.getBalances') return { body: xml('<UserGetBalancesResult Currency="USD" AvailableBalance="10.00" AccountBalance="10.00" EarnedAmount="0" WithdrawableAmount="0" FundsRequiredForAutoRenew="0" />') };
      if (cmd === 'namecheap.users.getPricing') return { body: xml('<UserGetPricingResult><ProductType Name="domains"><ProductCategory Name="register"><Product Name="nl"><Price Duration="1" DurationType="YEAR" Price="7.48" YourPrice="7.48" Currency="USD" /></Product></ProductCategory></ProductType></UserGetPricingResult>') };
      if (cmd === 'namecheap.domains.create') { creates++; return { body: xml('<DomainCreateResult Domain="a.nl" Registered="true" ChargedAmount="7.48" DomainID="1" OrderID="2" TransactionID="3" WhoisguardEnable="false" />') }; }
      return { body: xml('', 'ERROR') };
    }));
    expect(await service.clients.namecheap(orgId).balances()).toEqual({ available: 10, total: 10, currency: 'USD' });
    const est = await service.estimateBatch(orgId, ['a.nl', 'b.nl'], 1);
    expect(est.balance).toEqual({ available: 10, currency: 'USD' });
    const r = await service.runBatch(orgId, { domains: ['a.nl', 'b.nl'], forwardedDomain: 'x.nl', emailProvider: 'google', inboxesPerDomain: 1, prefixVariants: ['first'], personas: [{ domain: 'a.nl', firstName: 'A', lastName: 'B' }] });
    expect(r.bought).toEqual([]);
    expect(r.orderError).toMatch(/balance is 10.00 USD, the 2 registrations need 14.96/);
    expect(creates).toBe(0);
  });
});

describe('registrar auto-renew tracking', () => {
  it('records the auto-renew flag from the registrar list and names domains bought here that still have it on', async () => {
    const service = await import('../domains/service.js');
    const { NamecheapClient } = await import('../domains/namecheap.js');
    const { createOrgWithOwner } = await import('../tenancy/orgs.js');
    const { db, schema } = await import('../db/index.js');
    const orgId = createOrgWithOwner({ orgName: 'Renew Co', email: 'owner@renew.test', password: 'pw-pw-pw-pw-1' }).orgId;
    const cfg = { apiUser: 'u', apiKey: 'k', username: 'u', clientIp: '1.2.3.4', contact: { firstName: 'D', lastName: 'T', address1: 'S 1', city: 'A', stateProvince: 'NH', postalCode: '1', country: 'NL', phone: '+31.612345678', email: 'd@x.test' } };
    service.clients.namecheap = () => new NamecheapClient(cfg, fakeFetch((url) => {
      const cmd = new URL(url).searchParams.get('Command');
      if (cmd === 'namecheap.domains.getList') return { body: xml('<DomainGetListResult><Domain ID="1" Name="bought.nl" Expires="09/15/2027" IsExpired="false" AutoRenew="true" /><Domain ID="2" Name="old.nl" Expires="01/01/2027" IsExpired="false" AutoRenew="true" /></DomainGetListResult><Paging><TotalItems>2</TotalItems></Paging>') };
      return { body: xml('', 'ERROR') };
    }));
    const now = Date.now();
    db.insert(schema.domains).values({ id: 'r1', orgId, domain: 'bought.nl', registrar: 'namecheap', status: 'purchased', registrarJson: JSON.stringify({ orderId: '42', chargedAmount: 7.48 }), createdAt: now, updatedAt: now }).run();
    const r = await service.importRegistrarDomains(orgId);
    expect(r).toEqual({ imported: 1, total: 2, autoRenewOn: ['bought.nl'] });
    const ov = service.domainsOverview(orgId);
    const bought = ov.domains.find((d) => d.domain === 'bought.nl')!;
    expect(bought.platform).toBe(true);
    expect(bought.registrarInfo).toMatchObject({ orderId: '42', autoRenew: true });
    const old = ov.domains.find((d) => d.domain === 'old.nl')!;
    expect(old.platform).toBe(false);
    expect(old.registrarInfo.autoRenew).toBe(true);
  });
});
