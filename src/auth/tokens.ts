import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { encryptSecret, decryptSecret } from '../crypto/secrets.js';
import { refreshTokenGrant, type ProviderName, type TokenSet } from '../providers/oauth.js';
import { AuthError, ProviderConfigError } from '../providers/errors.js';
import { logger } from '../logger.js';
import { logActivity } from '../observability/activity.js';

const REFRESH_MARGIN_MS = 120_000;

// Serialize refreshes per account so concurrent senders/pollers don't race
// (Microsoft rotates refresh tokens on every use).
const inflight = new Map<string, Promise<string>>();

export function saveTokens(accountId: string, tokens: TokenSet): void {
  const now = Date.now();
  db.insert(schema.oauthTokens)
    .values({
      accountId,
      accessTokenEnc: encryptSecret(tokens.accessToken),
      refreshTokenEnc: encryptSecret(tokens.refreshToken ?? ''),
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.oauthTokens.accountId,
      set: {
        accessTokenEnc: encryptSecret(tokens.accessToken),
        // Keep the previous refresh token if the provider didn't rotate it
        ...(tokens.refreshToken
          ? { refreshTokenEnc: encryptSecret(tokens.refreshToken) }
          : {}),
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        updatedAt: now,
      },
    })
    .run();
}

// True when the account has a usable long-lived token on file. The connect
// flow checks this before accepting a grant: an account whose provider never
// returned a refresh token dies as soon as the access token expires.
export function hasRefreshToken(accountId: string): boolean {
  const row = db
    .select({ enc: schema.oauthTokens.refreshTokenEnc })
    .from(schema.oauthTokens)
    .where(eq(schema.oauthTokens.accountId, accountId))
    .get();
  if (!row) return false;
  try {
    return decryptSecret(row.enc).length > 0;
  } catch {
    return false;
  }
}

export interface ProviderProblem {
  provider: string;
  error: string;
  since: number;
  lastSeen: number;
  /** Refresh attempts that failed on it. */
  failures: number;
}

// One record per provider whose OAuth app is rejecting us outright. Kept in
// memory: it is a live condition, cleared by the first refresh that works
// again, and /healthz shows it so the operator sees it before the customers do.
const providerProblems = new Map<string, ProviderProblem>();
const PROVIDER_PROBLEM_LOG_INTERVAL_MS = 30 * 60_000;
// When the problem was last written to the log, and whether that write has
// been answered by an "accepted again" yet. A provider that flaps (a freshly
// rotated secret takes minutes to reach all of Microsoft's token servers)
// still gets at most one pair of rows per interval.
const providerProblemLoggedAt = new Map<string, number>();
const providerProblemAnnounced = new Set<string>();

/** Providers whose app credentials are currently being rejected. */
export function currentProviderProblems(): ProviderProblem[] {
  return [...providerProblems.values()];
}

function noteProviderProblem(err: ProviderConfigError, account: { id: string; email: string }): void {
  const now = Date.now();
  const existing = providerProblems.get(err.provider);
  if (existing) {
    existing.error = err.message;
    existing.lastSeen = now;
    existing.failures++;
  } else {
    providerProblems.set(err.provider, { provider: err.provider, error: err.message, since: now, lastSeen: now, failures: 1 });
  }
  // Every sequencer login hits this for every account: one log line and one
  // activity row per provider per half hour, not one per attempt.
  if (now - (providerProblemLoggedAt.get(err.provider) ?? 0) < PROVIDER_PROBLEM_LOG_INTERVAL_MS) return;
  providerProblemLoggedAt.set(err.provider, now);
  providerProblemAnnounced.add(err.provider);
  logger.error({ provider: err.provider, err: err.message, accountId: account.id, email: account.email }, 'provider rejects our OAuth app credentials; no account is paused, fix the app registration');
  logActivity({
    category: 'oauth',
    action: 'provider-config',
    status: 'failed',
    accountId: account.id,
    detail: `${err.provider}: the provider rejects this gateway's OAuth app credentials (client id/secret). Accounts are not paused; they recover once the app is fixed.`,
    error: err.message,
  });
}

function clearProviderProblem(provider: string): void {
  if (!providerProblems.delete(provider)) return;
  if (!providerProblemAnnounced.delete(provider)) return;
  logger.info({ provider }, 'provider accepts our OAuth app credentials again');
  logActivity({ category: 'oauth', action: 'provider-config', status: 'ok', detail: `${provider}: app credentials accepted again` });
}

export function markAuthError(accountId: string, message: string): void {
  db.update(schema.accounts)
    .set({ status: 'auth_error', lastError: message.slice(0, 500), updatedAt: Date.now() })
    .where(eq(schema.accounts.id, accountId))
    .run();
}

export async function getAccessToken(accountId: string): Promise<string> {
  const existing = inflight.get(accountId);
  if (existing) return existing;
  const promise = getAccessTokenInner(accountId).finally(() => inflight.delete(accountId));
  inflight.set(accountId, promise);
  return promise;
}

async function getAccessTokenInner(accountId: string): Promise<string> {
  const account = db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!account) throw new AuthError(`Unknown account ${accountId}`);

  const row = db
    .select()
    .from(schema.oauthTokens)
    .where(eq(schema.oauthTokens.accountId, accountId))
    .get();
  if (!row) throw new AuthError(`Account ${account.email} has no stored tokens`);

  if (row.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
    return decryptSecret(row.accessTokenEnc);
  }

  const refreshToken = decryptSecret(row.refreshTokenEnc);
  if (!refreshToken) {
    markAuthError(accountId, 'No refresh token stored; reconnect the account');
    throw new AuthError(`Account ${account.email} has no refresh token`);
  }

  try {
    const tokens = await refreshTokenGrant(account.provider as ProviderName, refreshToken);
    saveTokens(accountId, tokens);
    clearProviderProblem(account.provider);
    if (account.status === 'auth_error') {
      db.update(schema.accounts)
        .set({ status: 'active', lastError: null, updatedAt: Date.now() })
        .where(eq(schema.accounts.id, accountId))
        .run();
    }
    logger.debug({ accountId, email: account.email }, 'refreshed access token');
    return tokens.accessToken;
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      // Our app, not this account: leave its status alone so nothing downstream
      // treats it as broken, and surface the condition once.
      noteProviderProblem(err, account);
    } else if (err instanceof AuthError) {
      markAuthError(accountId, err.message);
      logger.warn(
        { accountId, email: account.email, err: err.message },
        'token refresh failed; account needs reconnect',
      );
      logActivity({
        category: 'oauth',
        action: 'token-refresh',
        status: 'failed',
        accountId,
        error: `Account paused — reconnect required: ${err.message}`,
      });
    }
    throw err;
  }
}

/** How long a paused (auth_error) account waits between refresh retries. */
export const AUTH_ERROR_RETRY_MS = 60 * 60_000;

/** One sweep pass: refresh active accounts whose token expires within 15
 *  minutes so long-idle accounts stay warm, and retry paused accounts once
 *  an hour. The retry is what heals a pause caused on our side (an expired
 *  app secret before ProviderConfigError existed, an outage misread as a
 *  revoked grant) without waiting for a sequencer to touch the mailbox; a
 *  genuinely revoked grant just fails again and moves its clock forward,
 *  since markAuthError stamps updatedAt. */
export async function refreshDueTokens(now = Date.now()): Promise<void> {
  const soon = now + 15 * 60_000;
  const rows = db
    .select({
      accountId: schema.oauthTokens.accountId,
      expiresAt: schema.oauthTokens.expiresAt,
      status: schema.accounts.status,
      updatedAt: schema.accounts.updatedAt,
    })
    .from(schema.oauthTokens)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.oauthTokens.accountId))
    .all();
  for (const row of rows) {
    if (row.status === 'active') {
      if (row.expiresAt > soon) continue;
    } else if (row.status === 'auth_error') {
      if (row.updatedAt > now - AUTH_ERROR_RETRY_MS) continue;
    } else {
      continue;
    }
    try {
      await getAccessToken(row.accountId);
    } catch (err) {
      logger.warn({ accountId: row.accountId, status: row.status, err: String(err) }, 'sweep refresh failed');
    }
  }
}

export function startTokenRefreshSweep(): NodeJS.Timeout {
  const SWEEP_INTERVAL = 10 * 60_000;
  const timer = setInterval(() => {
    refreshDueTokens().catch((err) => logger.warn({ err: String(err) }, 'token sweep failed'));
  }, SWEEP_INTERVAL);
  timer.unref();
  return timer;
}
