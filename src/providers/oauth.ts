import { config } from '../config.js';
import { AuthError, RetryableError } from './errors.js';

export type ProviderName = 'google' | 'microsoft';

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // unix-ms
  scopes: string;
}

// gmail.modify / Mail.ReadWrite (not the read-only variants): warmup tools
// need to move mail out of Spam and set read/star state upstream.
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

export const MICROSOFT_SCOPES = [
  'openid',
  'email',
  'offline_access',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Mail.ReadWrite',
];

interface Endpoints {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  extraAuthParams: Record<string, string>;
}

function endpoints(provider: ProviderName): Endpoints {
  if (provider === 'google') {
    if (!config.googleEnabled) throw new Error('Google OAuth is not configured');
    return {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientId: config.GOOGLE_CLIENT_ID!,
      clientSecret: config.GOOGLE_CLIENT_SECRET!,
      scopes: GOOGLE_SCOPES,
      // offline + consent forces Google to re-issue a refresh token
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    };
  }
  if (!config.microsoftEnabled) throw new Error('Microsoft OAuth is not configured');
  const tenant = config.MICROSOFT_TENANT;
  return {
    authUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    clientId: config.MICROSOFT_CLIENT_ID!,
    clientSecret: config.MICROSOFT_CLIENT_SECRET!,
    scopes: MICROSOFT_SCOPES,
    extraAuthParams: { response_mode: 'query', prompt: 'select_account' },
  };
}

export function redirectUri(provider: ProviderName): string {
  return `${config.BASE_URL.replace(/\/$/, '')}/auth/${provider}/callback`;
}

export function buildAuthUrl(provider: ProviderName, state: string): string {
  const ep = endpoints(provider);
  const params = new URLSearchParams({
    client_id: ep.clientId,
    redirect_uri: redirectUri(provider),
    response_type: 'code',
    scope: ep.scopes.join(' '),
    state,
    ...ep.extraAuthParams,
  });
  return `${ep.authUrl}?${params}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(
  provider: ProviderName,
  grant: Record<string, string>,
): Promise<TokenSet> {
  const ep = endpoints(provider);
  let res: Response;
  try {
    res = await fetch(ep.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: ep.clientId,
        client_secret: ep.clientSecret,
        ...grant,
      }),
    });
  } catch (err) {
    throw new RetryableError(`Token endpoint unreachable: ${String(err)}`);
  }
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    const desc = `${body.error ?? res.status}: ${body.error_description ?? 'token request failed'}`;
    if (body.error === 'invalid_grant' || res.status === 400 || res.status === 401) {
      throw new AuthError(desc);
    }
    throw new RetryableError(desc);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    scopes: body.scope ?? ep.scopes.join(' '),
  };
}

export function exchangeCode(provider: ProviderName, code: string): Promise<TokenSet> {
  return tokenRequest(provider, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(provider),
  });
}

export function refreshTokenGrant(
  provider: ProviderName,
  refreshToken: string,
): Promise<TokenSet> {
  return tokenRequest(provider, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

export async function fetchUserProfile(
  provider: ProviderName,
  accessToken: string,
): Promise<{ email: string; displayName: string | null }> {
  if (provider === 'google') {
    const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new AuthError(`userinfo failed: HTTP ${res.status}`);
    const body = (await res.json()) as { email?: string; name?: string };
    if (!body.email) throw new AuthError('Google userinfo returned no email');
    return { email: body.email.toLowerCase(), displayName: body.name ?? null };
  }
  const res = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new AuthError(`Graph /me failed: HTTP ${res.status}`);
  const body = (await res.json()) as {
    mail?: string;
    userPrincipalName?: string;
    displayName?: string;
  };
  const email = (body.mail ?? body.userPrincipalName ?? '').toLowerCase();
  if (!email) throw new AuthError('Graph /me returned no email address');
  return { email, displayName: body.displayName ?? null };
}
