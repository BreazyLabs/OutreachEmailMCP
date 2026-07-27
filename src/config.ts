import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';

const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  MASTER_KEY: z
    .string()
    .min(1, 'MASTER_KEY is required. Generate one with: openssl rand -base64 32')
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'MASTER_KEY must be 32 bytes of base64 (openssl rand -base64 32)'),
  BASE_URL: z.string().url().default('http://localhost:3000'),
  ADMIN_PASSWORD: z.string().min(1).default('change-me'),

  HTTP_PORT: z.coerce.number().int().default(3000),
  HTTP_BIND: z.string().default('127.0.0.1'),

  SMTP_PORT: z.coerce.number().int().default(2525),
  // Implicit-TLS (SMTPS, 465-style) listener; 0 disables it.
  SMTPS_PORT: z.coerce.number().int().min(0).default(465),
  SMTP_BIND: z.string().default('127.0.0.1'),
  SMTP_MAX_SIZE: z.coerce.number().int().default(25 * 1024 * 1024),
  SMTP_ALLOW_INSECURE_AUTH: boolFromEnv,
  SMTP_TLS_CERT: z.string().optional(),
  SMTP_TLS_KEY: z.string().optional(),
  // Hostname advertised to mail clients (CSV exports, UI) for SMTP/IMAP.
  // Defaults to BASE_URL's hostname — override when that domain sits behind a
  // proxying CDN (e.g. Cloudflare) that doesn't forward raw TCP ports.
  MAIL_HOST: z.string().optional(),

  IMAP_PORT: z.coerce.number().int().default(1143),
  // Implicit-TLS (IMAPS, 993-style) listener; 0 disables it.
  IMAPS_PORT: z.coerce.number().int().min(0).default(993),
  IMAP_BIND: z.string().default('127.0.0.1'),
  IMAP_ALLOW_INSECURE_AUTH: boolFromEnv,
  // How many recent INBOX messages to index per account on first IMAP use
  IMAP_BACKFILL_COUNT: z.coerce.number().int().min(0).max(500).default(50),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT: z.string().default('common'),

  POLL_INTERVAL: z.coerce.number().int().min(10).default(60),
  // How long to keep the raw .eml of successfully sent mail (debugging grace);
  // after this it is deleted — the provider's Sent folder keeps the canonical copy
  SENT_RAW_RETENTION_HOURS: z.coerce.number().min(0).default(24),
  WEBHOOKS_ALLOW_PRIVATE: boolFromEnv,

  // Default lifetime of provider-specific connect links, in hours (0 = never
  // expires; the dashboard's hub link is non-expiring and revocable instead).
  CONNECT_LINK_TTL_HOURS: z.coerce.number().int().min(0).default(168),

  // Daily health check: hour of the day (UTC) to run it, who to mail the
  // report to (comma-separated; defaults to each workspace's owners), and
  // whether to send even when nothing is wrong.
  HEALTH_REPORT_HOUR: z.coerce.number().int().min(0).max(23).default(7),
  HEALTH_REPORT_TO: z.string().optional(),
  HEALTH_REPORT_ALWAYS: boolFromEnv,

  // How long transaction/audit log rows are kept
  ACTIVITY_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  LOG_LEVEL: z.string().default('info'),
  DATA_DIR: z.string().default('./data'),

  // --- SaaS mode (multi-tenant with signup + quotas; off = self-hosted) ---
  SAAS_MODE: boolFromEnv,
  STRIPE_SECRET_KEY: z
    .string()
    .optional()
    .refine((v) => !v || v.startsWith('sk_') || v.startsWith('rk_'), {
      message: 'STRIPE_SECRET_KEY must be a secret key (sk_live_… / sk_test_…), not a publishable key',
    }),
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .optional()
    .refine((v) => !v || v.startsWith('whsec_'), {
      message: 'STRIPE_WEBHOOK_SECRET must be a webhook signing secret (whsec_…)',
    }),
  STRIPE_PRICE_PRO: z
    .string()
    .optional()
    .refine((v) => !v || v.startsWith('price_'), {
      message:
        'STRIPE_PRICE_PRO must be a Stripe Price ID (price_…) — create a recurring price in Product catalog and copy its API ID, not the numeric amount',
    }),
  PLAN_FREE_MAX_ACCOUNTS: z.coerce.number().int().default(2),
  PLAN_FREE_DAILY_SENDS: z.coerce.number().int().default(100),
  PLAN_PRO_MAX_ACCOUNTS: z.coerce.number().int().default(50),
  PLAN_PRO_DAILY_SENDS: z.coerce.number().int().default(5000),
});

function loadDotEnv() {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key!] !== undefined) continue;
    let value = raw!;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key!] = value;
  }
}

loadDotEnv();

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`Invalid configuration:\n${issues}`);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  ...env,
  masterKey: Buffer.from(env.MASTER_KEY, 'base64'),
  dataDir: path.resolve(process.cwd(), env.DATA_DIR),
  messagesDir: path.resolve(process.cwd(), env.DATA_DIR, 'messages'),
  certsDir: path.resolve(process.cwd(), env.DATA_DIR, 'certs'),
  googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  microsoftEnabled: Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET),
  stripeEnabled: Boolean(
    env.SAAS_MODE && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_PRO,
  ),
};

export type Config = typeof config;

for (const dir of [config.dataDir, config.messagesDir, config.certsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
