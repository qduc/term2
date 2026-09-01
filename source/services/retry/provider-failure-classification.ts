import { OpenAICompatibleError, OpenRouterError } from '../../providers/common/provider-errors.js';
import { describeError, isAbortLikeError } from '../../utils/error-helpers.js';
import { isNetworkProtocolError, isTransientRetryableError } from './retry-error-classification.js';
import { classifyUpstreamRetryableError } from './upstream-retry-policy.js';

export type ProviderFailureKind = 'network' | 'provider' | 'rate_limit' | 'authentication' | 'cancelled' | 'unknown';

export type ProviderFailureClassification = {
  errorKind: ProviderFailureKind;
  code?: string;
  status?: number;
  retryAfterMs?: number;
  message: string;
  retryable: boolean;
};

/** One sanitized, shared interpretation of an upstream failure. */
export function classifyProviderFailure(error: unknown): ProviderFailureClassification {
  const upstream = classifyUpstreamRetryableError(error);
  const statusRaw = error && typeof error === 'object' ? (error as any).status ?? (error as any).statusCode : undefined;
  const status = typeof statusRaw === 'number' && Number.isInteger(statusRaw) ? statusRaw : undefined;
  const codeRaw = findSafeField(error, 'code');
  const code = typeof codeRaw === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(codeRaw) ? codeRaw : undefined;
  const transport = isNetworkProtocolError(error);
  const retryable = transport || upstream.retryable || isTransientRetryableError(error);
  const errorKind: ProviderFailureKind = isAbortLikeError(error)
    ? 'cancelled'
    : status === 401 || status === 403
    ? 'authentication'
    : status === 429 || upstream.status === 429
    ? 'rate_limit'
    : transport
    ? 'network'
    : retryable ||
      (status !== undefined && status >= 400) ||
      error instanceof OpenRouterError ||
      error instanceof OpenAICompatibleError
    ? 'provider'
    : 'unknown';
  return {
    errorKind,
    ...(code ? { code } : {}),
    ...(status ?? upstream.status ? { status: status ?? upstream.status } : {}),
    ...(upstream.retryAfterMs !== undefined ? { retryAfterMs: upstream.retryAfterMs } : {}),
    message: describeError(error),
    retryable: errorKind !== 'cancelled' && errorKind !== 'authentication' && retryable,
  };
}

function findSafeField(error: unknown, field: 'code'): unknown {
  const seen = new Set<unknown>();
  const visit = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (typeof record[field] === 'string') return record[field];
    for (const child of [record.cause, record.error, ...(Array.isArray(record.errors) ? record.errors : [])]) {
      const found = visit(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(error);
}
