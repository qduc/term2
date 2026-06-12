/*
 * Shared upstream/provider retry policy.
 *
 * This module classifies transient provider/upstream failures and computes
 * backoff for the shared retry loop used by retry-handler, retry-executor,
 * and provider fallback paths. It does not cover model repair retries or the
 * user-initiated /retry command flow.
 */
import { APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError } from 'openai';
import { OpenAICompatibleError, OpenRouterError } from '../../providers/common/provider-errors.js';

export type UpstreamRetryClassification = {
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
  reason?: string;
};

type HeaderSource =
  | {
      get(name: string): string | null | undefined;
    }
  | Record<string, unknown>;

const RATE_LIMIT_MESSAGE_PATTERNS = ['rate limit', 'too many requests', 'rate_limit'];

const getMessage = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? '');
  }
  return '';
};

const parseStatus = (value: unknown): number | undefined => {
  const status = typeof value === 'number' ? value : parseInt(String(value), 10);
  return Number.isInteger(status) ? status : undefined;
};

const getHeadersSource = (source: unknown): HeaderSource | undefined => {
  if (!source || typeof source !== 'object') return undefined;

  if ('get' in source && typeof (source as { get?: unknown }).get === 'function') {
    return source as HeaderSource;
  }

  if ('headers' in source) {
    const headers = (source as { headers?: unknown }).headers;
    if (!headers || typeof headers !== 'object') return undefined;
    return headers as HeaderSource;
  }

  return source as HeaderSource;
};

const getHeaderValue = (source: unknown, name: string): string | undefined => {
  const headers = getHeadersSource(source);
  if (!headers) return undefined;

  if ('get' in headers && typeof headers.get === 'function') {
    const value = headers.get(name);
    return value == null ? undefined : String(value);
  }

  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) {
      const value = headers[key];
      return value == null ? undefined : String(value);
    }
  }

  return undefined;
};

export const getRetryAfterMs = (source: unknown): number | undefined => {
  const retryAfter = getHeaderValue(source, 'retry-after');
  if (retryAfter === undefined) return undefined;
  const retryAfterSeconds = parseInt(retryAfter, 10);
  return Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : undefined;
};

export function classifyUpstreamRetryableError(error: unknown): UpstreamRetryClassification {
  if (
    error instanceof APIConnectionError ||
    error instanceof APIConnectionTimeoutError ||
    error instanceof InternalServerError ||
    error instanceof RateLimitError
  ) {
    return {
      retryable: true,
      status: parseStatus((error as any).status),
      retryAfterMs: getRetryAfterMs(error),
      reason: 'openai-sdk',
    };
  }

  if (error instanceof OpenRouterError || error instanceof OpenAICompatibleError) {
    const status = error.status;
    const retryable = status === 429 || status >= 500;
    return {
      retryable,
      status,
      retryAfterMs: getRetryAfterMs(error.headers),
      reason: 'provider-status',
    };
  }

  if (!error || typeof error !== 'object') {
    return { retryable: false };
  }

  const status = parseStatus((error as { status?: unknown; statusCode?: unknown }).status ?? (error as any).statusCode);
  if (status !== undefined) {
    return {
      retryable: status === 429 || status >= 500,
      status,
      retryAfterMs: getRetryAfterMs(error),
      reason: 'generic-status',
    };
  }

  const message = getMessage(error).toLowerCase();
  const retryable = RATE_LIMIT_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern));
  return {
    retryable,
    retryAfterMs: getRetryAfterMs(error),
    ...(retryable ? { reason: 'rate-limit-message' } : {}),
  };
}

export function computeUpstreamRetryDelayMs({
  retryAfterMs,
  attemptIndex,
  attemptNumber,
  random = Math.random,
}: {
  retryAfterMs?: number;
  attemptIndex?: number;
  attemptNumber?: number;
  random?: () => number;
}): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs)) {
    return retryAfterMs;
  }

  if (attemptIndex !== undefined) {
    const baseDelay = 5000 + random() * 25000;
    const exponentialDelay = baseDelay * Math.pow(2, attemptIndex);
    const cappedDelay = Math.min(exponentialDelay, 30000);
    return random() * cappedDelay;
  }

  if (attemptNumber !== undefined) {
    const baseDelay = Math.min(500 * Math.pow(2, attemptNumber - 1), 30000);
    const jitter = 0.9 + random() * 0.2;
    return Math.round(baseDelay * jitter);
  }

  throw new Error(
    'computeUpstreamRetryDelayMs requires attemptIndex or attemptNumber when retryAfterMs is not provided',
  );
}
