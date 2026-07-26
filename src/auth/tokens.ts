import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { encryptSecret, decryptSecret } from '../crypto/secrets.js';
import { refreshTokenGrant, type ProviderName, type TokenSet } from '../providers/oauth.js';
import { AuthError } from '../providers/errors.js';
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
    if (account.status === 'auth_error') {
      db.update(schema.accounts)
        .set({ status: 'active', lastError: null, updatedAt: Date.now() })
        .where(eq(schema.accounts.id, accountId))
        .run();
    }
    logger.debug({ accountId, email: account.email }, 'refreshed access token');
    return tokens.accessToken;
  } catch (err) {
    if (err instanceof AuthError) {
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

// Proactively refresh tokens expiring soon so long-idle accounts stay warm.
export function startTokenRefreshSweep(): NodeJS.Timeout {
  const SWEEP_INTERVAL = 10 * 60_000;
  const timer = setInterval(async () => {
    const soon = Date.now() + 15 * 60_000;
    const rows = db
      .select({
        accountId: schema.oauthTokens.accountId,
        expiresAt: schema.oauthTokens.expiresAt,
        status: schema.accounts.status,
      })
      .from(schema.oauthTokens)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.oauthTokens.accountId))
      .all();
    for (const row of rows) {
      if (row.status !== 'active' || row.expiresAt > soon) continue;
      try {
        await getAccessToken(row.accountId);
      } catch (err) {
        logger.warn({ accountId: row.accountId, err: String(err) }, 'sweep refresh failed');
      }
    }
  }, SWEEP_INTERVAL);
  timer.unref();
  return timer;
}
