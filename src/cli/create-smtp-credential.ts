// Usage: npm run create-smtp-credential -- <account-email>
import { eq } from 'drizzle-orm';
import { db, schema, runMigrations } from '../db/index.js';
import { createSmtpCredential, smtpAdvertisedHost } from '../smtp/credentials.js';
import { config } from '../config.js';

runMigrations();
const email = process.argv[2]?.toLowerCase();
if (!email) {
  console.error('Usage: npm run create-smtp-credential -- <account-email>');
  process.exit(1);
}
const account = db
  .select()
  .from(schema.accounts)
  .where(eq(schema.accounts.email, email))
  .get();
if (!account) {
  console.error(`No connected account with email ${email}. Connect it via the web UI first.`);
  process.exit(1);
}
const { username, password } = createSmtpCredential(account);
console.log(`SMTP credential for ${email}:

  Server:   ${smtpAdvertisedHost()}:${config.SMTP_PORT} (STARTTLS)
  Username: ${username}
  Password: ${password}

MAIL FROM must be ${email}.`);
