import { describe, it, expect, beforeAll } from 'vitest';

process.env.MASTER_KEY = Buffer.alloc(32, 13).toString('base64');
process.env.DATA_DIR = './data-test/domains-api';
process.env.BASE_URL = 'http://localhost:3000';
process.env.SAAS_MODE = 'true';
process.env.PLAN_FREE_MAX_ACCOUNTS = '1';

const xml = (inner: string, status = 'OK') =>
  `<?xml version="1.0" encoding="utf-8"?><ApiResponse Status="${status}" xmlns="http://api.namecheap.com/xml.response"><Errors>${status === 'OK' ? '' : '<Error Number="2030280">nope</Error>'}</Errors><CommandResponse>${inner}</CommandResponse><Server>PHX01</Server></ApiResponse>`;

const fakeFetch = (routes: (url: string, init?: RequestInit) => { status?: number; body: string }) =>
  async (url: string, init?: RequestInit) => {
    const r = routes(url, init);
    return new Response(r.body, { status: r.status ?? 200 });
  };

const NC_CFG = { apiUser: 'u', apiKey: 'k', username: 'u', clientIp: '1.2.3.4', contact: { firstName: 'D', lastName: 'T', address1: 'S 1', city: 'A', stateProvince: 'NH', postalCode: '1', country: 'NL', phone: '+31.612345678', email: 'd@x.test' } };

describe('shared integrations', () => {
  let platformOrg: string;
  let tenantOrg: string;

  beforeAll(async () => {
    const { runMigrations } = await import('../db/index.js');
    runMigrations();
    const { createOrgWithOwner } = await import('../tenancy/orgs.js');
    platformOrg = createOrgWithOwner({ orgName: 'Platform', email: 'platform@shared.test', password: 'pw-pw-pw-pw-1' }).orgId;
    tenantOrg = createOrgWithOwner({ orgName: 'Tenant', email: 'tenant@shared.test', password: 'pw-pw-pw-pw-1' }).orgId;
    const { setIntegration } = await import('../domains/integrations.js');
    setIntegration(platformOrg, 'namecheap', NC_CFG);
    setIntegration(platformOrg, 'premiuminboxes', { apiToken: 'shared-tok', workspaceId: 'ws-shared', hosting: { platform: 'Namecheap' }, defaults: { emailProvider: 'Google', inboxesPerDomain: 2, prefixVariants: ['first'], insured: false } });
  });

  it('falls back to the shared workspace only when the env names one', async () => {
    const { getIntegration, integrationSource, setIntegration } = await import('../domains/integrations.js');
    delete process.env.SHARED_INTEGRATIONS_ORG_ID;
    expect(getIntegration(tenantOrg, 'premiuminboxes')).toBeNull();
    expect(integrationSource(tenantOrg, 'premiuminboxes')).toBeNull();
    process.env.SHARED_INTEGRATIONS_ORG_ID = platformOrg;
    expect(getIntegration(tenantOrg, 'premiuminboxes')?.apiToken).toBe('shared-tok');
    expect(integrationSource(tenantOrg, 'premiuminboxes')).toBe('shared');
    expect(integrationSource(platformOrg, 'premiuminboxes')).toBe('own');
    // A workspace's own credentials always win over the shared ones.
    setIntegration(tenantOrg, 'namecheap', { ...NC_CFG, apiUser: 'tenant-user' });
    expect(getIntegration(tenantOrg, 'namecheap')?.apiUser).toBe('tenant-user');
    expect(integrationSource(tenantOrg, 'namecheap')).toBe('own');
  });

  it('runs a batch for a tenant on the shared credentials and keeps syncing its orders', async () => {
    process.env.SHARED_INTEGRATIONS_ORG_ID = platformOrg;
    const service = await import('../domains/service.js');
    const { NamecheapClient } = await import('../domains/namecheap.js');
    const { PremiumInboxesClient } = await import('../domains/premiuminboxes.js');
    const { publicOrder } = await import('../api/domains.js');
    service.clients.namecheap = () => new NamecheapClient(NC_CFG, fakeFetch((url) => {
      const u = new URL(url);
      const cmd = u.searchParams.get('Command');
      if (cmd === 'namecheap.users.getBalances') return { body: xml('<UserGetBalancesResult Currency="USD" AvailableBalance="100.00" AccountBalance="100.00" />') };
      if (cmd === 'namecheap.users.getPricing') return { body: xml('<UserGetPricingResult><ProductType Name="domains"><ProductCategory Name="register"><Product Name="nl"><Price Duration="1" DurationType="YEAR" Price="7.48" YourPrice="7.48" Currency="USD" /></Product></ProductCategory></ProductType></UserGetPricingResult>') };
      if (cmd === 'namecheap.domains.create') return { body: xml(`<DomainCreateResult Domain="${u.searchParams.get('DomainName')}" Registered="true" ChargedAmount="7.48" DomainID="1" OrderID="2" TransactionID="3" WhoisguardEnable="true" />`) };
      if (cmd === 'namecheap.domains.getList') return { body: xml('<DomainGetListResult></DomainGetListResult><Paging><TotalItems>0</TotalItems></Paging>') };
      return { body: xml('', 'ERROR') };
    }));
    let purchaseWorkspace: string | undefined;
    service.clients.premiuminboxes = () => new PremiumInboxesClient('shared-tok', fakeFetch((url, init) => {
      if (url.endsWith('/client/purchase')) {
        purchaseWorkspace = ((init?.headers ?? {}) as Record<string, string>)['x-workspace-id'];
        return { body: '"ord_t"' };
      }
      if (url.endsWith('/client/order')) return { body: JSON.stringify({ data: [{ _id: 'ord_t', status: 'Delivered', emailProvider: 'Google', domains: ['gettenant.nl'], prefixVariants: [], issues: [], inboxes: { total: 2, perDomain: 2 }, emails: [{ firstName: 'Ann', lastName: 'Lee', email: 'ann@gettenant.nl', password: 'SECRET-PW', status: 'active' }], createdAt: '2026-09-15T10:00:00Z', updatedAt: '2026-09-15T10:00:00Z' }] }) };
      return { body: JSON.stringify({ data: [] }) };
    }));
    const est = await service.estimateBatch(tenantOrg, ['gettenant.nl'], 2);
    expect(est).toMatchObject({ domainTotal: 7.48, inboxes: 2, inboxTotalCents: 700 });
    const r = await service.runBatch(tenantOrg, { domains: ['gettenant.nl'], forwardedDomain: 'tenant.nl', emailProvider: 'google', inboxesPerDomain: 2, prefixVariants: ['first'], personas: [{ domain: 'gettenant.nl', firstName: 'Ann', lastName: 'Lee' }] });
    expect(r.bought).toEqual([{ domain: 'gettenant.nl', ok: true, chargedAmount: 7.48 }]);
    expect(r.order?.orgId).toBe(tenantOrg);
    expect(r.orderError).toBeNull();
    // The shared config carries the platform's Premium Inboxes workspace.
    expect(purchaseWorkspace).toBe('ws-shared');
    // The tenant has no integration row of its own, but its orders are still mirrored.
    expect(service.orgsWithOrders()).toContain(tenantOrg);
    await service.syncOrders(tenantOrg);
    const detail = service.orderMailboxes(tenantOrg, r.order!.id)!;
    expect(detail.emails[0]?.password).toBe('SECRET-PW'); // the internal read model still has it…
    const pub = publicOrder(detail.order, detail.result, new Set());
    expect(JSON.stringify(pub)).not.toContain('SECRET-PW'); // …the API never does.
    expect(pub.emails).toEqual([{ email: 'ann@gettenant.nl', firstName: 'Ann', lastName: 'Lee', status: 'active', connected: false }]);
    expect(pub).toMatchObject({ externalId: 'ord_t', status: 'Delivered', domains: ['gettenant.nl'], inboxes: { total: 2, perDomain: 2 } });
  });
});

describe('account adoption', () => {
  it('moves a mailbox between workspaces, respects the target quota, and drops the old workspace\'s account-pinned webhooks', async () => {
    const { runMigrations, db, schema } = await import('../db/index.js');
    runMigrations();
    const { createOrgWithOwner, QuotaError } = await import('../tenancy/orgs.js');
    const { adoptAccount, listAllAccounts, AdoptError } = await import('../accounts/adopt.js');
    const { encryptSecret } = await import('../crypto/secrets.js');
    const { eq } = await import('drizzle-orm');
    const from = createOrgWithOwner({ orgName: 'From', email: 'from@adopt.test', password: 'pw-pw-pw-pw-1' }).orgId;
    const to = createOrgWithOwner({ orgName: 'To', email: 'to@adopt.test', password: 'pw-pw-pw-pw-1' }).orgId;
    const now = Date.now();
    db.insert(schema.accounts).values({ id: 'acc_move', orgId: from, provider: 'google', email: 'move@adopt.test', displayName: null, status: 'active', createdAt: now, updatedAt: now }).run();
    db.insert(schema.webhooks).values({ id: 'wh_old', orgId: from, accountId: 'acc_move', url: 'https://old.test/hook', secretEnc: encryptSecret('s'), events: '["message.received"]', active: 1, createdAt: now }).run();
    db.insert(schema.webhooks).values({ id: 'wh_org', orgId: from, accountId: null, url: 'https://old.test/all', secretEnc: encryptSecret('s'), events: '["message.received"]', active: 1, createdAt: now }).run();

    const r = adoptAccount(to, 'acc_move');
    expect(r.fromOrgId).toBe(from);
    expect(r.account.orgId).toBe(to);
    expect(db.select().from(schema.webhooks).where(eq(schema.webhooks.id, 'wh_old')).get()).toBeUndefined();
    expect(db.select().from(schema.webhooks).where(eq(schema.webhooks.id, 'wh_org')).get()).toBeDefined();
    expect(listAllAccounts().find((a) => a.id === 'acc_move')).toMatchObject({ orgId: to, orgName: 'To', email: 'move@adopt.test' });
    // Idempotent: adopting into the workspace it is already in is a no-op.
    expect(adoptAccount(to, 'acc_move').fromOrgId).toBe(to);

    // The target is on the free plan with a 1-account cap: a second adoption is refused.
    db.insert(schema.accounts).values({ id: 'acc_two', orgId: from, provider: 'microsoft', email: 'two@adopt.test', displayName: null, status: 'active', createdAt: now, updatedAt: now }).run();
    expect(() => adoptAccount(to, 'acc_two')).toThrow(QuotaError);
    expect(db.select().from(schema.accounts).where(eq(schema.accounts.id, 'acc_two')).get()?.orgId).toBe(from);
    expect(() => adoptAccount('org_nope', 'acc_two')).toThrow(AdoptError);
    expect(() => adoptAccount(from, 'acc_nope')).toThrow(AdoptError);
  });
});

describe('explicit Message-IDs on API sends', () => {
  it('stamps the caller\'s Message-ID, In-Reply-To and References into the MIME', async () => {
    const { buildMime, messageIdOf } = await import('../api/messages-send.js');
    const raw = await buildMime({
      from: 'me@x.test',
      to: ['you@y.test'],
      subject: 'hi',
      text: 'hello',
      messageId: '<send-42@thread.breazyleads.com>',
      inReplyTo: '<prev-1@thread.breazyleads.com>',
      references: ['<root@thread.breazyleads.com>', '<prev-1@thread.breazyleads.com>'],
    });
    const head = raw.toString('utf8').split(/\r?\n\r?\n/)[0]!;
    expect(head).toMatch(/^Message-ID: <send-42@thread\.breazyleads\.com>$/m);
    expect(head).toMatch(/^In-Reply-To: <prev-1@thread\.breazyleads\.com>$/m);
    expect(head).toMatch(/^References: <root@thread\.breazyleads\.com> <prev-1@thread\.breazyleads\.com>$/m);
    expect(messageIdOf(raw)).toBe('<send-42@thread.breazyleads.com>');
    // Without one, nodemailer generates an id and we read it back.
    const generated = await buildMime({ from: 'me@x.test', to: ['you@y.test'], subject: 'hi', text: 'hello' });
    expect(messageIdOf(generated)).toMatch(/^<[^>]+@[^>]+>$/);
  });
});

describe('move a mailbox between workspaces (adoptAccount)', () => {
  it('moves the account and its dependents, enforces the target plan, and drops old-workspace webhooks', async () => {
    process.env.SAAS_MODE = 'false';
    const { runMigrations, db, schema } = await import('../db/index.js');
    runMigrations();
    const { createOrgWithOwner } = await import('../tenancy/orgs.js');
    const { adoptAccount, AdoptError, listAllAccounts } = await import('../accounts/adopt.js');
    const { QuotaError } = await import('../tenancy/orgs.js');
    const a = createOrgWithOwner({ orgName: 'Src', email: 'src@mv.test', password: 'pw-pw-pw-pw-1' }).orgId;
    const b = createOrgWithOwner({ orgName: 'Dst', email: 'dst@mv.test', password: 'pw-pw-pw-pw-1' }).orgId;
    const now = Date.now();
    db.insert(schema.accounts).values({ id: 'mv1', orgId: a, provider: 'google', email: 'x@mv.test', displayName: null, status: 'active', createdAt: now, updatedAt: now }).run();
    db.insert(schema.smtpCredentials).values({ id: 'c1', accountId: 'mv1', username: 'u', passwordEnc: 'e', createdAt: now }).run();
    db.insert(schema.webhooks).values({ id: 'w-acct', orgId: a, accountId: 'mv1', url: 'https://x.test/h', secretEnc: 'e', events: JSON.stringify(['message.received']), createdAt: now }).run();
    db.insert(schema.webhooks).values({ id: 'w-org', orgId: a, accountId: null, url: 'https://x.test/all', secretEnc: 'e', events: JSON.stringify(['message.received']), createdAt: now }).run();

    const { eq } = await import('drizzle-orm');
    const res = adoptAccount(b, 'mv1');
    expect(res.fromOrgId).toBe(a);
    expect(db.select().from(schema.accounts).where(eq(schema.accounts.id, 'mv1')).get()!.orgId).toBe(b);
    // credential followed the account id, untouched
    expect(db.select().from(schema.smtpCredentials).where(eq(schema.smtpCredentials.accountId, 'mv1')).get()!.username).toBe('u');
    // the account-pinned webhook in the old workspace is gone; the org-wide one stays
    const mine = db.select().from(schema.webhooks).all().map((w) => w.id).filter((id) => id === 'w-acct' || id === 'w-org').sort();
    expect(mine).toEqual(['w-org']);
    // listAllAccounts shows it under the new workspace
    expect(listAllAccounts().find((x) => x.id === 'mv1')).toMatchObject({ orgId: b, orgName: 'Dst' });
    // unknown account / workspace
    expect(() => adoptAccount(b, 'nope')).toThrow(AdoptError);
    expect(() => adoptAccount('no-org', 'mv1')).toThrow(AdoptError);
    // same workspace is a no-op, not an error
    expect(adoptAccount(b, 'mv1').fromOrgId).toBe(b);
    // free plan cap (2) on the target is enforced
    db.insert(schema.accounts).values({ id: 'mv2', orgId: a, provider: 'google', email: 'y@mv.test', displayName: null, status: 'active', createdAt: now, updatedAt: now }).run();
    db.insert(schema.accounts).values({ id: 'mv3', orgId: b, provider: 'google', email: 'z@mv.test', displayName: null, status: 'active', createdAt: now, updatedAt: now }).run();
    expect(() => adoptAccount(b, 'mv2')).toThrow(QuotaError);
  });
});
