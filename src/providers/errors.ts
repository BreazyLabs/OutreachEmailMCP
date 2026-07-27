// Error taxonomy used by the queue to decide retry behavior.

export class AuthError extends Error {
  readonly kind = 'auth';
}

export class RetryableError extends Error {
  readonly kind = 'retryable';
}

export class PermanentError extends Error {
  readonly kind = 'permanent';
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
  throw new PermanentError(message);
}
