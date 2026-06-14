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
