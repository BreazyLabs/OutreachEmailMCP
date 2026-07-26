import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

// Tenancy: every customer-facing resource hangs off an org. Self-hosted mode
// uses a single auto-seeded org (DEFAULT_ORG_ID) and hides all of this.
export const orgs = sqliteTable('orgs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  plan: text('plan', { enum: ['free', 'pro'] }).notNull().default('free'),
  status: text('status', { enum: ['active', 'suspended'] }).notNull().default('active'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  // Bumped to invalidate every connect link ever issued for this workspace.
  // Connect links are stateless, so this counter is the only revocation lever.
  connectLinkVersion: integer('connect_link_version').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['owner', 'member'] }).notNull().default('owner'),
  createdAt: integer('created_at').notNull(),
});

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().default('org_default'),
    provider: text('provider', { enum: ['google', 'microsoft'] }).notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    status: text('status', { enum: ['active', 'auth_error', 'disabled'] })
      .notNull()
      .default('active'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('accounts_provider_email').on(t.provider, t.email)],
);

export const oauthTokens = sqliteTable('oauth_tokens', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  accessTokenEnc: text('access_token_enc').notNull(),
  // For Google: the refresh token. For Microsoft: the serialized MSAL token cache.
  refreshTokenEnc: text('refresh_token_enc').notNull(),
  expiresAt: integer('expires_at').notNull(),
  scopes: text('scopes').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const smtpCredentials = sqliteTable('smtp_credentials', {
  id: text('id').primaryKey(),
  accountId: text('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  username: text('username').notNull().unique(),
  // AES-GCM-encrypted (not hashed): machine-generated, and must stay readable
  // for CSV export / re-display so external tools can be (re)configured anytime
  passwordEnc: text('password_enc').notNull(),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  revokedAt: integer('revoked_at'),
});

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().default('org_default'),
  name: text('name').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  // JSON array of scopes: ["*"] or subset of ["send","read","accounts","webhooks","export"]
  scopes: text('scopes').notNull().default('["*"]'),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  revokedAt: integer('revoked_at'),
});

export const sendJobs = sqliteTable(
  'send_jobs',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    source: text('source', { enum: ['api', 'smtp'] }).notNull(),
    status: text('status', {
      enum: ['queued', 'sending', 'sent', 'failed', 'cancelled'],
    })
      .notNull()
      .default('queued'),
    // Spool file; nulled once the retention sweep deletes it after a successful send
    rawPath: text('raw_path'),
    envelopeJson: text('envelope_json').notNull(),
    subject: text('subject'),
    // RFC822 Message-ID header — lets sent mail be re-fetched from the provider
    // later (Graph sendMail returns no id, but supports internetMessageId lookup)
    messageId: text('message_id'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    lockedAt: integer('locked_at'),
    lockedBy: text('locked_by'),
    providerMessageId: text('provider_message_id'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    sentAt: integer('sent_at'),
  },
  (t) => [
    index('send_jobs_status_next').on(t.status, t.nextAttemptAt),
    index('send_jobs_account_created').on(t.accountId, t.createdAt),
  ],
);

export const webhooks = sqliteTable('webhooks', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().default('org_default'),
  // null = fires for all of the org's accounts
  accountId: text('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  secretEnc: text('secret_enc').notNull(),
  events: text('events').notNull().default('["message.received"]'),
  active: integer('active').notNull().default(1),
  createdAt: integer('created_at').notNull(),
});

export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    webhookId: text('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    payloadJson: text('payload_json').notNull(),
    status: text('status', { enum: ['pending', 'delivering', 'delivered', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    lockedAt: integer('locked_at'),
    responseStatus: integer('response_status'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    deliveredAt: integer('delivered_at'),
  },
  (t) => [index('webhook_deliveries_status_next').on(t.status, t.nextAttemptAt)],
);

export const syncState = sqliteTable('sync_state', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  cursor: text('cursor'),
  lastPolledAt: integer('last_polled_at'),
  lastError: text('last_error'),
  imapBackfilled: integer('imap_backfilled').notNull().default(0),
});

// Local UID index for the IMAP facade: stable UIDs + flags + cached envelope
// per provider message. Bodies are NOT stored — fetched live on demand.
export const imapMessages = sqliteTable(
  'imap_messages',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    folder: text('folder').notNull().default('INBOX'),
    uid: integer('uid').notNull(),
    providerMessageId: text('provider_message_id').notNull(),
    internalDate: integer('internal_date').notNull(),
    size: integer('size').notNull(),
    // {date, subject, from:[{name,address}], to:[...], cc:[...], messageId, inReplyTo}
    envelopeJson: text('envelope_json').notNull(),
    // Set for APPENDed messages stored on disk (no provider copy exists)
    localPath: text('local_path'),
    seen: integer('seen').notNull().default(0),
    answered: integer('answered').notNull().default(0),
    flagged: integer('flagged').notNull().default(0),
    deleted: integer('deleted').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('imap_messages_account_folder_uid').on(t.accountId, t.folder, t.uid),
    uniqueIndex('imap_messages_account_provider').on(t.accountId, t.providerMessageId),
    index('imap_messages_account_folder').on(t.accountId, t.folder),
  ],
);

// Transaction log: one row per meaningful operation (auth, submit, delivery
// attempt, warmup move, flag sync, poll failure, webhook attempt, token
// refresh) with pass/fail — the "is something wrong?" audit surface.
export const activityLog = sqliteTable(
  'activity_log',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().default('org_default'),
    accountId: text('account_id'),
    accountEmail: text('account_email'),
    category: text('category').notNull(), // smtp|imap|api|mcp|delivery|poll|webhook|oauth
    action: text('action').notNull(), // auth|submit|send|attempt|move|flags|refresh|connect|...
    status: text('status', { enum: ['ok', 'failed'] }).notNull(),
    detail: text('detail'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('activity_org_created').on(t.orgId, t.createdAt),
    index('activity_account_created').on(t.accountId, t.createdAt),
    index('activity_status_created').on(t.status, t.createdAt),
  ],
);

export const uiSessions = sqliteTable('ui_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export type Org = typeof orgs.$inferSelect;
export type User = typeof users.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type OauthTokenRow = typeof oauthTokens.$inferSelect;
export type SendJob = typeof sendJobs.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type SmtpCredential = typeof smtpCredentials.$inferSelect;
export type ImapMessage = typeof imapMessages.$inferSelect;
