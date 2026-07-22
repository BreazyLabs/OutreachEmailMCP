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
