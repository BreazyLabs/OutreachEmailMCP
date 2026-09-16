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
  // Bootstrap secret for the cross-tenant provisioning API (creating
  // workspaces + minting their keys). Unset = that surface is disabled.
  ADMIN_API_KEY: z.string().min(16).optional(),
  // Workspace whose Namecheap / Premium Inboxes credentials every other
  // workspace falls back to when it has none of its own: the embedding
  // product buys domains and mailboxes on the platform's account.
  SHARED_INTEGRATIONS_ORG_ID: z.string().min(1).optional(),

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
  // What clients are told to connect to. Set these when TLS is terminated in
  // front of the app (a proxy owns 465/993 and forwards to the STARTTLS
  // ports): sequencers assume SSL-on-connect and fail on a STARTTLS port
  // with "wrong version number".
  SMTP_ADVERTISED_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  IMAP_ADVERTISED_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  IMAP_BIND: z.string().default('127.0.0.1'),
  IMAP_ALLOW_INSECURE_AUTH: boolFromEnv,
  // How many recent INBOX messages to index per account on first IMAP use
  IMAP_BACKFILL_COUNT: z.coerce.number().int().min(0).max(500).default(50),

  // --- Internal (tailnet) sign-in via Pocket ID ---
  // The hostname the shared nginx gateway serves this app under. Requests
  // arriving with any other Host are treated as public, whatever they claim.
  INTERNAL_HOSTNAME: z.string().default('emailproxy.internal'),
  // Shared secret nginx stamps onto every internal request. Unset disables
  // internal sign-in entirely — the check fails closed rather than open.
  INTERNAL_GATEWAY_SECRET: z.string().optional(),
  OIDC_ISSUER: z.string().url().default('https://id.internal'),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  // Origin the OIDC redirect_uri is built from. Defaults to the internal
  // hostname over https, which is how it is served in production; override it
  // for local development (e.g. http://localhost:3111), where the same client
  // works because both callbacks are registered on it.
  INTERNAL_BASE_URL: z.string().url().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT: z.string().default('common'),

  // Capped at 7 days: setInterval silently degrades to ~1 ms above 2^31-1
  // milliseconds, which turns a "poll rarely" setting into a poll storm.
  POLL_INTERVAL: z.coerce.number().int().min(10).max(604_800).default(60),
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

  // --- Warmup engine ---
  // Global kill switch: off stops every warmup loop; state is preserved.
  WARMUP_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === undefined || v === 'true' || v === '1'),
  // Hard ceiling on warmup sends per mailbox per day that no org or account
  // setting can exceed.
  WARMUP_MAX_DAILY_PER_ACCOUNT: z.coerce.number().int().min(1).default(50),
  // Below this many opted-in mailboxes the pool cannot form pairs; the health
  // check warns below 5 either way.
  WARMUP_MIN_POOL_SIZE: z.coerce.number().int().min(2).default(2),
  // Any OpenAI-compatible chat-completions endpoint for writing conversation
  // scripts. Unset = the bundled template corpus only.
  WARMUP_LLM_BASE_URL: z.string().url().optional(),
  WARMUP_LLM_API_KEY: z.string().optional(),
  WARMUP_LLM_MODEL: z.string().default('gpt-4o-mini'),
  // Cost guard: LLM calls per UTC day, instance-wide.
  WARMUP_LLM_DAILY_CALL_BUDGET: z.coerce.number().int().min(0).default(200),
  // Unused scripts to keep on hand per language; topped up in batches.
  WARMUP_SCRIPT_POOL_MIN: z.coerce.number().int().min(0).default(200),
  // A script opens at most this many conversations per day across the pool,
  // so the same subject does not show up in dozens of mailboxes at once.
  WARMUP_SCRIPT_MAX_USES_PER_DAY: z.coerce.number().int().min(1).default(5),
  // Share of conversations that reuse an already-used script (with its
  // rotating words re-rolled) rather than a fresh one. Real mailboxes repeat
  // themselves; a pool where every message is unique looks generated.
  WARMUP_SCRIPT_REUSE_PERCENT: z.coerce.number().int().min(0).max(100).default(66),
  // A script is retired after this many uses instance-wide.
  WARMUP_SCRIPT_MAX_USES: z.coerce.number().int().min(1).default(40),
  // How often each opted-in mailbox's Spam folder is listed.
  WARMUP_SPAM_SWEEP_SECONDS: z.coerce.number().int().min(60).default(600),
  // Sent but not seen in INBOX, Spam or a category by then = missing.
  WARMUP_ARRIVAL_TIMEOUT_HOURS: z.coerce.number().min(1).default(6),
  // A send task due longer ago than this when the engine gets to it is
  // skipped rather than executed late (never burst after downtime).
  WARMUP_TASK_GRACE_MINUTES: z.coerce.number().int().min(1).default(45),
  // SaaS-mode per-mailbox daily warmup caps by plan.
  PLAN_FREE_WARMUP_DAILY: z.coerce.number().int().min(0).default(10),
  PLAN_PRO_WARMUP_DAILY: z.coerce.number().int().min(0).default(50),

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
  // Plan quotas; 0 = unlimited. The pro plan is unlimited by default —
  // a workspace that pays should never hit a mailbox ceiling.
  PLAN_FREE_MAX_ACCOUNTS: z.coerce.number().int().min(0).default(2),
  PLAN_FREE_DAILY_SENDS: z.coerce.number().int().min(0).default(100),
  PLAN_PRO_MAX_ACCOUNTS: z.coerce.number().int().min(0).default(0),
  PLAN_PRO_DAILY_SENDS: z.coerce.number().int().min(0).default(0),
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

// A compose file that forwards `${VAR:-}` hands the app an empty string for
// anything unset; that must read as "not configured", not as a bad value.
for (const key of Object.keys(process.env)) {
  if (process.env[key] === '') delete process.env[key];
}

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
  // All three are required: without the gateway secret an internal request is
  // indistinguishable from a forged one, so the whole route stays off.
  internalSsoConfigured: Boolean(
    env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET && env.INTERNAL_GATEWAY_SECRET,
  ),
  // The origin the redirect URI registered with Pocket ID is built from.
  // Pinned to the internal hostname rather than BASE_URL, which is the public
  // one, unless explicitly overridden for local development.
  internalBaseUrl: (env.INTERNAL_BASE_URL ?? `https://${env.INTERNAL_HOSTNAME}`).replace(
    /\/$/,
    '',
  ),
  microsoftEnabled: Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET),
  stripeEnabled: Boolean(
    env.SAAS_MODE && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_PRO,
  ),
};

export type Config = typeof config;

for (const dir of [config.dataDir, config.messagesDir, config.certsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
