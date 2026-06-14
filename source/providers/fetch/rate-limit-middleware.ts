import type { FetchMiddleware } from './compose.js';

/**
 * Parses a Retry-After header value into seconds.
 * Supports both:
 *  - Decimal integer seconds (e.g. "120")
 *  - HTTP-date (e.g. "Wed, 21 Oct 2015 07:28:00 GMT")
 */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;

  const trimmed = value.trim();

  // Try decimal integer seconds
  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds;
  }

  // Try HTTP-date
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }

  return null;
}

/**
 * Middleware that intercepts HTTP 429 (Too Many Requests) responses.
 * If the Retry-After header indicates a wait longer than 60 seconds,
 * returns the 429 with an `x-should-retry: false` header so the OpenAI
 * SDK does not automatically retry. Without this header the SDK retries
 * all 429s by default, which causes an excessively long wait the user
 * is unaware of.
 *
 * The app-level retry layer (RetryingModel / classifyUpstreamRetryableError)
 * also checks retry-after on the resulting RateLimitError and skips its own
 * retry when the delay exceeds 60 seconds.
 */
export function createRateLimitMiddleware(): FetchMiddleware {
  return async (ctx, next) => {
    const response = await next(ctx);

    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));

      if (retryAfter !== null && retryAfter > 60) {
        // Clone the response and add x-should-retry: false to prevent
        // the OpenAI SDK from retrying this 429 automatically.
        const headers = new Headers(response.headers);
        headers.set('x-should-retry', 'false');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
    }

    return response;
  };
}
