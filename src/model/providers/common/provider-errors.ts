export class OpenRouterError extends Error {
  status: number;
  headers: Record<string, string>;
  responseBody?: string;

  constructor(message: string, status: number, headers: Record<string, string>, responseBody?: string) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
    this.headers = headers;
    this.responseBody = responseBody;
  }
}

export class OpenAICompatibleError extends Error {
  status: number;
  headers: Record<string, string>;
  responseBody?: string;

  constructor(message: string, status: number, headers: Record<string, string>, responseBody?: string) {
    super(message);
    this.name = 'OpenAICompatibleError';
    this.status = status;
    this.headers = headers;
    this.responseBody = responseBody;
  }
}

/**
 * Thrown by the fetch rate-limit middleware when a 429 response has a
 * retry-after header exceeding 60 seconds. Prevents the SDK from waiting
 * for an excessively long retry window without the user's awareness.
 */
export class LongRetryDelayError extends Error {
  retryAfter: number;

  constructor(retryAfter: number) {
    super(`Rate limited with retry-after=${retryAfter}s (>60s threshold). Aborting to prevent excessively long wait.`);
    this.name = 'LongRetryDelayError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Thrown by a provider's auth middleware when the stored credential cannot be
 * used and only a human re-login can fix it — no token to refresh, or an
 * imported CLI token that has expired.
 *
 * It needs its own class because it is thrown from inside `fetch`. The OpenAI
 * SDK wraps any throw from its fetch impl in `APIConnectionError('Connection
 * error.')`, which retry classification reads as a transient network fault. The
 * result was ~9 pointless retries across three retry layers and a user-facing
 * "Connection error." in place of the instruction that would have fixed it.
 */
export class ProviderReauthenticationRequiredError extends Error {
  readonly requiresReauthentication = true;

  constructor(message: string) {
    super(message);
    this.name = 'ProviderReauthenticationRequiredError';
  }
}

/**
 * Walks the `cause` chain, because the SDK's `APIConnectionError` wrapper is
 * what callers actually catch.
 */
export function findReauthenticationRequiredError(error: unknown): ProviderReauthenticationRequiredError | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    if (current instanceof ProviderReauthenticationRequiredError) return current;
    if ((current as any).requiresReauthentication === true) return current as ProviderReauthenticationRequiredError;
    seen.add(current);
    current = (current as any).cause;
  }
  return undefined;
}
