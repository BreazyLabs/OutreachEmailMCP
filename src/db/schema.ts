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
  // --- Warmup, workspace level ---
  // Partial WarmupSettings JSON applied to every mailbox in the org unless the
  // mailbox overrides a field. Null = instance defaults.
  warmupDefaultsJson: text('warmup_defaults_json'),
  // 'instance': pairs with every opted-in mailbox on the proxy;
  // 'org': this workspace's mailboxes only talk to each other (symmetric —
  // an org that opts out is also invisible to the instance pool).
  warmupPoolScope: text('warmup_pool_scope', { enum: ['instance', 'org'] })
    .notNull()
    .default('instance'),
  // Body tag stamped into every warmup message the org's mailboxes send, so
  // external tools (and our own filters) can recognise it. Generated on first
  // enable; editable.
  warmupFilterTag: text('warmup_filter_tag'),
  // Off by default: the proxy identifies its own warmup mail through the
  // registry, so the visible tag only matters for tools that read the
  // mailboxes without going through the proxy — and it is a fingerprint.
  warmupTagEnabled: integer('warmup_tag_enabled').notNull().default(0),
  // A tag that was replaced keeps matching for a while so in-flight threads
  // still filter. JSON [{tag, until}].
  warmupOldTagsJson: text('warmup_old_tags_json'),
  warmupEmitWebhooks: integer('warmup_emit_webhooks').notNull().default(0),
  warmupShowInSendLog: integer('warmup_show_in_send_log').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  // `superadmin` is platform-level: it can see, enter and create EVERY
  // workspace. Granted only through the partner SSO handoff, never by
  // signup, so it cannot be self-assigned.
  role: text('role', { enum: ['owner', 'member', 'superadmin'] })
    .notNull()
    .default('owner'),
  // Pocket ID subject for operators who sign in through the internal IdP.
  // Identity is keyed on this, never on email: an address can be reassigned
  // to a different person, `sub` cannot.
  oidcSub: text('oidc_sub').unique(),
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
    /** JSON array of free-form labels (campaign, client, batch). */
    tagsJson: text('tags_json'),
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
    // 'warmup' jobs are generated by the warmup engine; every stats, quota,
    // send-log and webhook surface excludes them by default.
    source: text('source', { enum: ['api', 'smtp', 'warmup'] }).notNull(),
    warmupMessageId: text('warmup_message_id'),
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
    // Post-delivery outcomes, filled in by the inbound poller when a DSN or a
    // reply arrives that correlates back to this job's Message-ID. A send is
    // only "delivered" in the sense that the provider accepted it; a bounce
    // that lands minutes later is the real verdict, so it is recorded here
    // rather than mutating `status` (the job genuinely did send).
    bouncedAt: integer('bounced_at'),
    // hard = permanent (5.x.x, unknown recipient); soft = transient (4.x.x)
    bounceType: text('bounce_type', { enum: ['hard', 'soft'] }),
    // Enhanced status code from the DSN, e.g. "5.1.1"
    bounceCode: text('bounce_code'),
    bounceRecipient: text('bounce_recipient'),
    bounceDiagnostic: text('bounce_diagnostic'),
    repliedAt: integer('replied_at'),
    // Provider message id of the inbound reply, so consumers can fetch it
    replyMessageId: text('reply_message_id'),
  },
  (t) => [
    index('send_jobs_status_next').on(t.status, t.nextAttemptAt),
    index('send_jobs_account_created').on(t.accountId, t.createdAt),
    // Correlating an inbound DSN/reply back to its send job is a hot path on
    // every polled message, and Message-ID is the only stable join key.
    index('send_jobs_message_id').on(t.messageId),
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
    // Set at index time for warmup traffic; IMAP listings never show these
    // rows, so a sequencer's reply detection never sees pool chatter.
    warmup: integer('warmup').notNull().default(0),
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
  // Workspace a superadmin has switched into. Null = their own org.
  // Held on the session, not the user, so two tabs can look at different
  // workspaces without fighting over one global "current org".
  actingOrgId: text('acting_org_id'),
});

// ---------------------------------------------------------------------------
// Warmup engine. Every mailbox on the proxy can opt into a pool in which the
// mailboxes exchange human-looking mail with each other; the engine watches
// where each message lands and engages with it (read, star, reply, forward,
// rescue from spam). All of it is rows, so a restart loses nothing.
// ---------------------------------------------------------------------------

export const warmupAccounts = sqliteTable('warmup_accounts', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  enabled: integer('enabled').notNull().default(0),
  // ramping: volume still climbing; steady: at daily limit; paused: by a
  // person; auto_paused: by the reputation controller (lifts itself);
  // blocked_upstream: the account row is not active (mirrors, lifts itself).
  state: text('state', {
    enum: ['off', 'ramping', 'steady', 'paused', 'auto_paused', 'blocked_upstream'],
  })
    .notNull()
    .default('off'),
  // Sending days completed. Only advances on days the mailbox actually sent,
  // so downtime holds the ramp instead of skipping steps.
  rampDay: integer('ramp_day').notNull().default(0),
  rampAdvancedDate: text('ramp_advanced_date'),
  startedAt: integer('started_at'),
  // Partial WarmupSettings JSON overriding the org/instance defaults.
  settingsJson: text('settings_json'),
  // {firstName, lastName, role, company, signOff}
  personaJson: text('persona_json'),
  lastPlannedDate: text('last_planned_date'),
  todayTarget: integer('today_target').notNull().default(0),
  // Reputation controller output: percentage applied to the planned target
  // (100 = normal, 50 = slowed).
  throttlePercent: integer('throttle_percent').notNull().default(100),
  cleanDays: integer('clean_days').notNull().default(0),
  pausedUntil: integer('paused_until'),
  pauseReason: text('pause_reason'),
  lastSpamSweepAt: integer('last_spam_sweep_at'),
  // Provider ids already inspected in the Spam folder (bounded list), so a
  // restart does not re-fetch the whole folder.
  spamSeenJson: text('spam_seen_json'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const warmupThreads = sqliteTable(
  'warmup_threads',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['conversation', 'forward'] }).notNull().default('conversation'),
    initiatorAccountId: text('initiator_account_id').notNull(),
    // JSON string[] of every account id on the thread (To + Cc). Replies go
    // to everyone but the replier ("reply all").
    participantsJson: text('participants_json').notNull(),
    subject: text('subject').notNull(),
    scriptId: text('script_id'),
    language: text('language').notNull().default('en'),
    turnsPlanned: integer('turns_planned').notNull(),
    turnsDone: integer('turns_done').notNull().default(0),
    state: text('state', { enum: ['active', 'done', 'abandoned'] }).notNull().default('active'),
    // Set when a real person (not the engine) replied on this thread — the
    // engine must never talk to humans, so the thread ends there.
    humanRepliedAt: integer('human_replied_at'),
    // Same-domain / same-org "internal" conversation.
    internal: integer('internal').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('warmup_threads_initiator').on(t.initiatorAccountId, t.createdAt)],
);

// The registry and the outcome ledger: one row per message the engine sent.
export const warmupMessages = sqliteTable(
  'warmup_messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id').notNull(),
    turn: integer('turn').notNull(),
    kind: text('kind', { enum: ['open', 'reply', 'forward', 'mdn'] }).notNull(),
    fromAccountId: text('from_account_id').notNull(),
    // Primary recipient. Cc'd pool accounts are listed alongside; where the
    // message landed for each recipient is tracked in warmup_landings.
    toAccountId: text('to_account_id').notNull(),
    ccAccountIdsJson: text('cc_account_ids_json'),
    // Normalised (lowercase, no brackets) RFC822 Message-ID we generated.
    rfcMessageId: text('rfc_message_id').notNull(),
    inReplyToMessageId: text('in_reply_to_message_id'),
    subject: text('subject').notNull(),
    // Plain-text body as sent, so a reply or forward can quote it without
    // fetching the message back from the recipient's mailbox.
    bodyText: text('body_text'),
    sendJobId: text('send_job_id'),
    contentSource: text('content_source', { enum: ['llm', 'template', 'ack', 'system'] })
      .notNull()
      .default('template'),
    requestedReceipt: integer('requested_receipt').notNull().default(0),
    // Sender-local calendar date, for per-day rollups without tz maths.
    localDate: text('local_date').notNull(),
    createdAt: integer('created_at').notNull(),
    sentAt: integer('sent_at'),
    failedAt: integer('failed_at'),
    failError: text('fail_error'),
    // Sent but not seen anywhere by then = missing.
    expectedBy: integer('expected_by'),
  },
  (t) => [
    uniqueIndex('warmup_messages_rfc_id').on(t.rfcMessageId),
    index('warmup_messages_from_date').on(t.fromAccountId, t.localDate),
    index('warmup_messages_thread').on(t.threadId, t.turn),
    index('warmup_messages_send_job').on(t.sendJobId),
  ],
);

// Where a warmup message landed for one recipient, and what the recipient
// then did with it. A message with a Cc has one landing per recipient.
export const warmupLandings = sqliteTable(
  'warmup_landings',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull(),
    fromAccountId: text('from_account_id').notNull(),
    toAccountId: text('to_account_id').notNull(),
    // Sender-local date of the send, copied for rollups.
    localDate: text('local_date').notNull(),
    landed: text('landed', {
      enum: ['inbox', 'spam', 'promotions', 'social', 'updates', 'forums', 'other', 'missing', 'bounced'],
    }),
    landedAt: integer('landed_at'),
    // The recipient mailbox's provider id for the message (changes on Graph
    // moves; kept current).
    providerMessageId: text('provider_message_id'),
    rescuedAt: integer('rescued_at'),
    categoryFixedAt: integer('category_fixed_at'),
    readAt: integer('read_at'),
    starredAt: integer('starred_at'),
    importantAt: integer('important_at'),
    receiptSentAt: integer('receipt_sent_at'),
    repliedAt: integer('replied_at'),
    forwardedAt: integer('forwarded_at'),
    cleanedAt: integer('cleaned_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('warmup_landings_message_to').on(t.messageId, t.toAccountId),
    index('warmup_landings_to').on(t.toAccountId, t.createdAt),
    index('warmup_landings_from_date').on(t.fromAccountId, t.localDate),
    index('warmup_landings_pending').on(t.landed, t.createdAt),
  ],
);

// Durable work queue for everything with a "do at" time. Same claim/lease/
// reap idiom as send_jobs.
export const warmupTasks = sqliteTable(
  'warmup_tasks',
  {
    id: text('id').primaryKey(),
    // The account performing the action.
    accountId: text('account_id').notNull(),
    // The other mailbox involved (recipient of a send, sender of a message
    // being engaged with) — lets the planner count a mailbox's inbound load.
    counterpartyAccountId: text('counterparty_account_id'),
    kind: text('kind', {
      enum: [
        'send_open',
        'send_reply',
        'send_forward',
        'send_mdn',
        'mark_read',
        'star',
        'mark_important',
        'rescue',
        'fix_category',
        'cleanup',
      ],
    }).notNull(),
    dueAt: integer('due_at').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadJson: text('payload_json').notNull(),
    status: text('status', { enum: ['pending', 'claimed', 'done', 'skipped', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lockedAt: integer('locked_at'),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    doneAt: integer('done_at'),
  },
  (t) => [
    uniqueIndex('warmup_tasks_idempotency').on(t.idempotencyKey),
    index('warmup_tasks_status_due').on(t.status, t.dueAt),
    index('warmup_tasks_account_kind').on(t.accountId, t.kind, t.dueAt),
    index('warmup_tasks_counterparty').on(t.counterpartyAccountId, t.kind, t.dueAt),
  ],
);

// Generated conversation scripts: a subject plus 1–5 turns.
export const warmupScripts = sqliteTable(
  'warmup_scripts',
  {
    id: text('id').primaryKey(),
    language: text('language').notNull(),
    register: text('register', { enum: ['casual', 'business'] }).notNull(),
    topic: text('topic'),
    subject: text('subject').notNull(),
    turnsJson: text('turns_json').notNull(),
    source: text('source', { enum: ['llm', 'template'] }).notNull(),
    usedCount: integer('used_count').notNull().default(0),
    retired: integer('retired').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('warmup_scripts_pick').on(t.language, t.register, t.retired, t.usedCount)],
);

// Sending-domain DNS posture (SPF, DKIM, DMARC, MX), refreshed daily: warmup
// cannot fix a domain that fails authentication, so the dashboard says so.
export const domainHealth = sqliteTable('domain_health', {
  domain: text('domain').primaryKey(),
  checkedAt: integer('checked_at').notNull(),
  spf: text('spf'),
  spfOk: integer('spf_ok').notNull().default(0),
  dmarc: text('dmarc'),
  dmarcPolicy: text('dmarc_policy'),
  dmarcOk: integer('dmarc_ok').notNull().default(0),
  // JSON string[] of DKIM selectors that resolve (google, selector1, selector2, …)
  dkimSelectorsJson: text('dkim_selectors_json'),
  dkimOk: integer('dkim_ok').notNull().default(0),
  mxJson: text('mx_json'),
  mxOk: integer('mx_ok').notNull().default(0),
  // JSON string[] of human-readable problems
  issuesJson: text('issues_json'),
  error: text('error'),
});

// Singleton leases for the background loops. Several app instances may run
// at once (rolling deploys); exactly one — the holder of the 'workers' lease —
// polls mailboxes, sends, runs warmup and delivers webhooks. The others only
// serve SMTP, IMAP and HTTP and take the lease over when it expires.
export const leases = sqliteTable('leases', {
  name: text('name').primaryKey(),
  holder: text('holder').notNull(),
  acquiredAt: integer('acquired_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export type Org = typeof orgs.$inferSelect;
export type DomainHealth = typeof domainHealth.$inferSelect;
export type WarmupAccount = typeof warmupAccounts.$inferSelect;
export type WarmupThread = typeof warmupThreads.$inferSelect;
export type WarmupMessage = typeof warmupMessages.$inferSelect;
export type WarmupLanding = typeof warmupLandings.$inferSelect;
export type WarmupTask = typeof warmupTasks.$inferSelect;
export type WarmupScript = typeof warmupScripts.$inferSelect;
export type User = typeof users.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type OauthTokenRow = typeof oauthTokens.$inferSelect;
export type SendJob = typeof sendJobs.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type SmtpCredential = typeof smtpCredentials.$inferSelect;
export type ImapMessage = typeof imapMessages.$inferSelect;
