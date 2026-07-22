import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  generateSmtpPassword,
  randomBase62,
  verifySmtpPassword,
} from '../crypto/credentials.js';
import { encryptSecret, decryptSecret } from '../crypto/secrets.js';
import { config } from '../config.js';
import type { Account } from '../db/schema.js';

export function createSmtpCredential(account: Account): { username: string; password: string } {
  const localPart = account.email.split('@')[0]!.replace(/[^a-z0-9.]/gi, '').toLowerCase();
  const username = `${localPart}.${account.provider}.${randomBase62(6).toLowerCase()}`;
  const password = generateSmtpPassword();
  db.insert(schema.smtpCredentials)
    .values({
      id: nanoid(),
      accountId: account.id,
      username,
      passwordEnc: encryptSecret(password),
      createdAt: Date.now(),
    })
    .run();
  return { username, password };
}

// Hostname external clients should use to reach the SMTP listener.
export function smtpAdvertisedHost(): string {
  return config.SMTP_BIND === '0.0.0.0' ? new URL(config.BASE_URL).hostname : config.SMTP_BIND;
}

// Shared by the SMTP and IMAP listeners: one proxy credential works for both.
// Returns the owning account on success, marks the credential used.
export function verifyProxyCredential(username: string, password: string): Account | null {
  const credential = db
    .select()
    .from(schema.smtpCredentials)
    .where(eq(schema.smtpCredentials.username, username.toLowerCase()))
    .get();
  if (!credential || credential.revokedAt) return null;
  let stored: string;
  try {
    stored = decryptSecret(credential.passwordEnc);
  } catch {
    return null; // undecryptable row (e.g. MASTER_KEY changed)
  }
  if (!verifySmtpPassword(password, stored)) return null;
  const account = db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, credential.accountId))
    .get();
  if (!account || account.status === 'disabled') return null;
  db.update(schema.smtpCredentials)
    .set({ lastUsedAt: Date.now() })
    .where(eq(schema.smtpCredentials.id, credential.id))
    .run();
  return account;
}
