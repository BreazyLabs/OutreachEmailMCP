import { desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { decryptSecret } from '../crypto/secrets.js';
import { createSmtpCredential, smtpAdvertisedHost } from '../smtp/credentials.js';
import { config } from '../config.js';

export interface AccountExportRow {
  email: string;
  displayName: string;
  firstName: string;
  lastName: string;
  provider: string;
  status: string;
  host: string;
  smtpPort: number;
  imapPort: number;
  username: string;
  password: string;
}

function csvField(value: string | number | null): string {
  const s = value === null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

// One row per non-disabled account with ready-to-use proxy credentials.
// Accounts without an active SMTP credential get one auto-generated, so every
// export is complete and directly importable.
export function collectExportRows(orgId: string): AccountExportRow[] {
  const host = smtpAdvertisedHost();
  const rows: AccountExportRow[] = [];
  const accounts = db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.orgId, orgId))
    .orderBy(desc(schema.accounts.createdAt))
    .all();
  for (const account of accounts) {
    if (account.status === 'disabled') continue;
    const credential = db
      .select()
      .from(schema.smtpCredentials)
      .where(eq(schema.smtpCredentials.accountId, account.id))
      .orderBy(desc(schema.smtpCredentials.createdAt))
      .all()
      .find((c) => !c.revokedAt);
    const { username, password } = credential
      ? { username: credential.username, password: decryptSecret(credential.passwordEnc) }
      : createSmtpCredential(account);
    const displayName = account.displayName ?? '';
    const [firstName, ...rest] = displayName.split(' ');
    rows.push({
      email: account.email,
      displayName,
      firstName: firstName ?? '',
      lastName: rest.join(' '),
      provider: account.provider,
      status: account.status,
      host,
      // Advertise the implicit-TLS ports when they are enabled: sequencers
      // overwhelmingly assume SSL-on-connect for mail ports, and pointing them
      // at the STARTTLS listener fails deep inside their TLS stack with an
      // error nobody can act on ("wrong version number").
      smtpPort: config.SMTPS_PORT > 0 ? config.SMTPS_PORT : config.SMTP_PORT,
      imapPort: config.IMAPS_PORT > 0 ? config.IMAPS_PORT : config.IMAP_PORT,
      username,
      password,
    });
  }
  return rows;
}

// Column layouts for the bulk-import screens of common sequencers. Each entry
// maps header label -> row field renderer.
type Column = [string, (r: AccountExportRow) => string | number];

const SEQUENCER_COLUMNS: Record<string, Column[]> = {
  generic: [
    ['email', (r) => r.email],
    ['display_name', (r) => r.displayName],
    ['first_name', (r) => r.firstName],
    ['last_name', (r) => r.lastName],
    ['provider', (r) => r.provider],
    ['status', (r) => r.status],
    ['smtp_host', (r) => r.host],
    ['smtp_port', (r) => r.smtpPort],
    ['smtp_username', (r) => r.username],
    ['smtp_password', (r) => r.password],
    ['imap_host', (r) => r.host],
    ['imap_port', (r) => r.imapPort],
    ['imap_username', (r) => r.username],
    ['imap_password', (r) => r.password],
  ],
  instantly: [
    ['Email', (r) => r.email],
    ['First Name', (r) => r.firstName],
    ['Last Name', (r) => r.lastName],
    ['IMAP Username', (r) => r.username],
    ['IMAP Password', (r) => r.password],
    ['IMAP Host', (r) => r.host],
    ['IMAP Port', (r) => r.imapPort],
    ['SMTP Username', (r) => r.username],
    ['SMTP Password', (r) => r.password],
    ['SMTP Host', (r) => r.host],
    ['SMTP Port', (r) => r.smtpPort],
  ],
  smartlead: [
    ['from_name', (r) => r.displayName || r.email],
    ['from_email', (r) => r.email],
    ['user_name', (r) => r.username],
    ['password', (r) => r.password],
    ['smtp_host', (r) => r.host],
    ['smtp_port', (r) => r.smtpPort],
    ['imap_host', (r) => r.host],
    ['imap_port', (r) => r.imapPort],
  ],
  lemlist: [
    ['email', (r) => r.email],
    ['firstName', (r) => r.firstName],
    ['lastName', (r) => r.lastName],
    ['smtpUsername', (r) => r.username],
    ['smtpPassword', (r) => r.password],
    ['smtpHost', (r) => r.host],
    ['smtpPort', (r) => r.smtpPort],
    ['imapUsername', (r) => r.username],
    ['imapPassword', (r) => r.password],
    ['imapHost', (r) => r.host],
    ['imapPort', (r) => r.imapPort],
  ],
  replyio: [
    ['Email', (r) => r.email],
    ['First Name', (r) => r.firstName],
    ['Last Name', (r) => r.lastName],
    ['SMTP Host', (r) => r.host],
    ['SMTP Port', (r) => r.smtpPort],
    ['SMTP Login', (r) => r.username],
    ['SMTP Password', (r) => r.password],
    ['IMAP Host', (r) => r.host],
    ['IMAP Port', (r) => r.imapPort],
    ['IMAP Login', (r) => r.username],
    ['IMAP Password', (r) => r.password],
  ],
  woodpecker: [
    ['Email', (r) => r.email],
    ['First name', (r) => r.firstName],
    ['Last name', (r) => r.lastName],
    ['SMTP host', (r) => r.host],
    ['SMTP port', (r) => r.smtpPort],
    ['SMTP login', (r) => r.username],
    ['SMTP password', (r) => r.password],
    ['IMAP host', (r) => r.host],
    ['IMAP port', (r) => r.imapPort],
    ['IMAP login', (r) => r.username],
    ['IMAP password', (r) => r.password],
  ],
};

export const SEQUENCER_FORMATS = Object.keys(SEQUENCER_COLUMNS);

export const SEQUENCER_LABELS: Record<string, string> = {
  generic: 'Generic CSV',
  instantly: 'Instantly',
  smartlead: 'Smartlead',
  lemlist: 'Lemlist',
  replyio: 'Reply.io',
  woodpecker: 'Woodpecker',
};

export function buildAccountsCsv(orgId: string, format = 'generic'): string {
  const columns = SEQUENCER_COLUMNS[format] ?? SEQUENCER_COLUMNS.generic!;
  const rows = collectExportRows(orgId);
  const lines = [columns.map(([label]) => csvField(label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map(([, render]) => csvField(render(row))).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
