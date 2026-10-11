// Error taxonomy used by the queue to decide retry behavior.

export class AuthError extends Error {
  readonly kind = 'auth';
}

export class RetryableError extends Error {
  readonly kind = 'retryable';
}

// Our own OAuth app is misconfigured at the provider — an expired or rotated
// client secret, a deleted app registration, a redirect we no longer own.
// Every account on that provider fails the same way at once, and none of them
// is actually broken: fixing the app makes them all work again without a
// reconnect. So this must never pause an account or be reported as that
// account's fault; it retries like an outage and alerts the operator instead.
export class ProviderConfigError extends RetryableError {
  readonly configError = true;
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(message);
  }
}

// Token-endpoint errors that mean the app, not the grant, is at fault.
// RFC 6749 names `invalid_client` and `unauthorized_client`; Microsoft's
// AADSTS7000xxx codes say the same about the app's keys and registration.
const APP_SIDE_TOKEN_ERRORS = new Set(['invalid_client', 'unauthorized_client']);

export function isAppSideTokenError(error: string | undefined, description: string | undefined): boolean {
  if (error && APP_SIDE_TOKEN_ERRORS.has(error)) return true;
  return /AADSTS(7000\d{3}|700016)\b/.test(description ?? '');
}

export class PermanentError extends Error {
  readonly kind = 'permanent';
}

// The message id we hold no longer resolves upstream: it was deleted, moved by
// someone else, or (on Graph, which reassigns ids on every move) already moved
// by us. Retrying can never succeed — the caller's index row is stale and the
// only cure is to forget it.
export class MessageGoneError extends PermanentError {}

export function isMessageGone(err: unknown): boolean {
  return err instanceof MessageGoneError;
}

// The account authenticates fine but has no usable mailbox behind it — a
// Microsoft identity with no Exchange Online licence (or an on-premise
// mailbox), or a Google account with Gmail switched off. Retrying never helps
// and the fix is always on the provider's side, so this is worth telling the
// person apart from every other failure.
const NO_MAILBOX_SIGNALS = [
  'MailboxNotEnabledForRESTAPI', // Graph: unlicensed, inactive, or on-prem
  'MailboxNotHostedInExchangeOnline',
  'ResourceNotFound: Mailbox',
  'failedPrecondition', // Gmail API when the account has no Gmail
  'Mail service not enabled',
];

export function isMailboxUnavailable(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return NO_MAILBOX_SIGNALS.some((s) => text.includes(s));
}

export async function throwForResponse(res: Response, context: string): Promise<never> {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 500);
  } catch {
    // body unavailable
  }
  const message = `${context}: HTTP ${res.status} ${detail}`;
  if (res.status === 401) throw new AuthError(message);
  if (res.status === 429 || res.status >= 500) throw new RetryableError(message);
  // A 404 about the mailbox itself is an account problem, not a stale id
  if (res.status === 404 && !isMailboxUnavailable(message)) throw new MessageGoneError(message);
  throw new PermanentError(message);
}
