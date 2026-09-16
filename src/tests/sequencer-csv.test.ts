import { describe, it, expect, beforeAll } from 'vitest';

process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.DATA_DIR = './data-test/sequencer';
process.env.BASE_URL = 'http://localhost:3000'; // vite injects BASE_URL='/'

let orgId: string;

beforeAll(async () => {
  const { runMigrations, db, schema } = await import('../db/index.js');
  runMigrations();
  const { createOrgWithOwner } = await import('../tenancy/orgs.js');
  orgId = createOrgWithOwner({
    orgName: 'CSV',
    email: 'csv@test.local',
    password: 'password-abc',
  }).orgId;
  const now = Date.now();
  db.insert(schema.accounts)
    .values({
      id: 'csv-acct',
      orgId,
      provider: 'google',
      email: 'jane@gmail.com',
      displayName: 'Jane Van Doe',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run();
});

describe('sequencer CSV export', () => {
  it('produces the Instantly column layout with credentials', async () => {
    const { buildAccountsCsv } = await import('../export/accounts-csv.js');
    const csv = buildAccountsCsv(orgId, 'instantly');
    const [header, row] = csv.trim().split('\r\n');
    expect(header).toBe(
      'Email,First Name,Last Name,IMAP Username,IMAP Password,IMAP Host,IMAP Port,SMTP Username,SMTP Password,SMTP Host,SMTP Port',
    );
    const cells = row!.split(',');
    expect(cells[0]).toBe('jane@gmail.com');
    expect(cells[1]).toBe('Jane');
    expect(cells[2]).toBe('Van Doe');
    expect(cells[3]).toMatch(/^jane\.google\./); // imap username
    expect(cells[4]).toHaveLength(24); // password auto-generated + readable
    expect(cells[3]).toBe(cells[7]); // same credential for imap+smtp
    expect(cells[4]).toBe(cells[8]);
  });

  it('reuses the same credential across formats and exports', async () => {
    const { buildAccountsCsv } = await import('../export/accounts-csv.js');
    const a = buildAccountsCsv(orgId, 'smartlead');
    const b = buildAccountsCsv(orgId, 'lemlist');
    const pass = (csv: string) => csv.trim().split('\r\n')[1]!.split(',')[3];
    expect(pass(a)).toBeDefined();
    // smartlead row: from_name,from_email,user_name,password -> index 3
    // lemlist row: email,firstName,lastName,smtpUsername,smtpPassword -> index 4
    expect(a.trim().split('\r\n')[1]!.split(',')[3]).toBe(
      b.trim().split('\r\n')[1]!.split(',')[4],
    );
  });

  it('falls back to generic for unknown formats', async () => {
    const { buildAccountsCsv } = await import('../export/accounts-csv.js');
    expect(buildAccountsCsv(orgId, 'nonsense').startsWith('email,display_name')).toBe(true);
  });
});

describe('api key scopes', () => {
  it('wildcard grants everything, subsets are enforced', async () => {
    const { hasScope } = await import('../api/plugin.js');
    expect(hasScope(['*'], 'send')).toBe(true);
    expect(hasScope(['send', 'read'], 'send')).toBe(true);
    expect(hasScope(['send', 'read'], 'webhooks')).toBe(false);
    expect(hasScope(undefined, 'read')).toBe(false);
  });
});

describe('export names and selection', () => {
  it('uses stored names, then the display name, then a guess from the address', async () => {
    const { db, schema } = await import('../db/index.js');
    const { namesFor } = await import('../accounts/profile.js');
    const now = Date.now();
    db.insert(schema.accounts)
      .values({ id: 'csv-guess', orgId, provider: 'google', email: 'steven.kasper@scale8.test', displayName: null, status: 'active', createdAt: now, updatedAt: now })
      .run();
    db.insert(schema.accounts)
      .values({ id: 'csv-stored', orgId, provider: 'microsoft', email: 'x@corp.test', displayName: 'X Corp', firstName: 'Xavier', lastName: 'Corp', status: 'active', createdAt: now, updatedAt: now })
      .run();
    const guess = namesFor(db.select().from(schema.accounts).where((await import('drizzle-orm')).eq(schema.accounts.id, 'csv-guess')).get()!);
    expect(guess).toMatchObject({ firstName: 'Steven', lastName: 'Kasper', source: 'derived' });
    const stored = namesFor(db.select().from(schema.accounts).where((await import('drizzle-orm')).eq(schema.accounts.id, 'csv-stored')).get()!);
    expect(stored).toMatchObject({ firstName: 'Xavier', lastName: 'Corp', displayName: 'X Corp', source: 'account' });
  });

  it('exports only the selected mailboxes, or only one tag', async () => {
    const { buildAccountsCsv } = await import('../export/accounts-csv.js');
    const { setAccountTags } = await import('../accounts/tags.js');
    setAccountTags('csv-stored', ['batch-1']);
    const emails = (csv: string) => csv.trim().split('\r\n').slice(1).map((l) => l.split(',')[0]);
    expect(emails(buildAccountsCsv(orgId, 'instantly', { accountIds: ['csv-guess', 'nope'] }))).toEqual(['steven.kasper@scale8.test']);
    expect(emails(buildAccountsCsv(orgId, 'instantly', { tag: 'BATCH-1' }))).toEqual(['x@corp.test']);
    expect(emails(buildAccountsCsv(orgId, 'instantly')).length).toBe(3);
    const row = buildAccountsCsv(orgId, 'instantly', { accountIds: ['csv-guess'] }).trim().split('\r\n')[1]!.split(',');
    expect(row.slice(0, 3)).toEqual(['steven.kasper@scale8.test', 'Steven', 'Kasper']);
  });
});

describe('names borrowed from siblings and set in bulk', () => {
  it('completes steven@ with the last name of steven.kasper@ on the same domain', async () => {
    const { db, schema } = await import('../db/index.js');
    const { eq } = await import('drizzle-orm');
    const { namesFor } = await import('../accounts/profile.js');
    const now = Date.now();
    db.insert(schema.accounts)
      .values({ id: 'csv-sib', orgId, provider: 'google', email: 'steven@scale8.test', displayName: null, status: 'active', createdAt: now, updatedAt: now })
      .run();
    db.insert(schema.accounts)
      .values({ id: 'csv-initial', orgId, provider: 'google', email: 'thom.v@slim.test', displayName: null, status: 'active', createdAt: now, updatedAt: now })
      .run();
    const sib = namesFor(db.select().from(schema.accounts).where(eq(schema.accounts.id, 'csv-sib')).get()!);
    expect(sib).toMatchObject({ firstName: 'Steven', lastName: 'Kasper', source: 'derived' });
    const initial = namesFor(db.select().from(schema.accounts).where(eq(schema.accounts.id, 'csv-initial')).get()!);
    expect(initial).toMatchObject({ firstName: 'Thom', lastName: '' });
  });

  it('sets a name on a selection through the bulk endpoint', async () => {
    const { runBulk } = await import('../warmup/api.js');
    const { namesFor, accountsMissingNames } = await import('../accounts/profile.js');
    const { db, schema } = await import('../db/index.js');
    const { eq } = await import('drizzle-orm');
    expect(accountsMissingNames(orgId).map((a) => a.email)).toContain('thom.v@slim.test');
    runBulk(orgId, { accountIds: ['csv-initial'], action: 'names', names: { lastName: 'Vermeer' } });
    const n = namesFor(db.select().from(schema.accounts).where(eq(schema.accounts.id, 'csv-initial')).get()!);
    expect(n).toMatchObject({ firstName: 'Thom', lastName: 'Vermeer', source: 'account' });
    expect(accountsMissingNames(orgId).map((a) => a.email)).not.toContain('thom.v@slim.test');
  });
});

describe('advertised ports', () => {
  it('prefers explicit advertised ports over the listener ports', async () => {
    const { config } = await import('../config.js');
    const { advertisedPorts } = await import('../smtp/credentials.js');
    const mutable = config as unknown as Record<string, unknown>;
    const saved = { s: mutable.SMTP_ADVERTISED_PORT, i: mutable.IMAP_ADVERTISED_PORT, ss: mutable.SMTPS_PORT, is: mutable.IMAPS_PORT };
    try {
      mutable.SMTPS_PORT = 0; mutable.IMAPS_PORT = 0; mutable.SMTP_ADVERTISED_PORT = undefined; mutable.IMAP_ADVERTISED_PORT = undefined;
      expect(advertisedPorts()).toEqual({ smtp: config.SMTP_PORT, imap: config.IMAP_PORT, implicitTls: false });
      mutable.SMTP_ADVERTISED_PORT = 465; mutable.IMAP_ADVERTISED_PORT = 993;
      expect(advertisedPorts()).toEqual({ smtp: 465, imap: 993, implicitTls: true });
      const { buildAccountsCsv } = await import('../export/accounts-csv.js');
      const row = buildAccountsCsv(orgId, 'instantly').trim().split('\r\n')[1]!.split(',');
      expect(row[6]).toBe('993');
      expect(row[10]).toBe('465');
    } finally {
      Object.assign(mutable, { SMTP_ADVERTISED_PORT: saved.s, IMAP_ADVERTISED_PORT: saved.i, SMTPS_PORT: saved.ss, IMAPS_PORT: saved.is });
    }
  });
});
