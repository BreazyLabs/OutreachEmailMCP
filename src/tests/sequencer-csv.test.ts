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
