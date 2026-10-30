/*
 * Shared upstream/provider retry policy.
 *
 * This module classifies transient provider/upstream failures and computes
 * backoff for the shared retry loop used by retry-handler and the provider
 * retry paths. It does not cover model repair retries or the user-initiated
 * /retry command flow.
 */
import { APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError } from 'openai';
import { OpenAICompatibleError, OpenRouterError, LongRetryDelayError } from '../../providers/common/provider-errors.js';
const RATE_LIMIT_MESSAGE_PATTERNS = ['rate limit', 'too many requests', 'rate_limit'];
const getMessage = (error) => {
    if (typeof error === 'string')
        return error;
    if (error && typeof error === 'object') {
        const msg = error.message;
        if (typeof msg === 'string')
            return msg;
        const nested = error.error?.message;
        if (typeof nested === 'string')
            return nested;
    }
    return '';
};
const parseStatus = (value) => {
    if (typeof value === 'number' && Number.isInteger(value))
        return value;
    if (typeof value === 'string') {
        const parsed = parseInt(value, 10);
        return Number.isInteger(parsed) && String(parsed) === value.trim() ? parsed : undefined;
    }
    return undefined;
};
const getHeadersSource = (source) => {
    if (!source || typeof source !== 'object')
        return undefined;
    if ('get' in source && typeof source.get === 'function') {
        return source;
    }
    if ('headers' in source) {
        const headers = source.headers;
        if (!headers || typeof headers !== 'object')
            return undefined;
        return headers;
    }
    if ('responseHeaders' in source) {
        return getHeadersSource(source.responseHeaders);
    }
    return source;
};
const getHeaderValue = (source, name) => {
    const headers = getHeadersSource(source);
    if (!headers)
        return undefined;
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
export const getRetryAfterMs = (source) => {
    const retryAfter = getHeaderValue(source, 'retry-after');
    const headerDelay = parseSeconds(retryAfter);
    if (headerDelay !== undefined)
        return headerDelay;
    if (!source || typeof source !== 'object')
        return undefined;
    // AI SDK retains Google's raw error body; its validated error data omits
    // google.rpc.RetryInfo. Read that structured hint before the message fallback.
    const responseBody = source.responseBody;
    if (typeof responseBody === 'string') {
        try {
            const body = JSON.parse(responseBody);
            const details = body?.error?.details;
            if (Array.isArray(details)) {
                for (const detail of details) {
                    if (detail?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo') {
                        const delay = parseSeconds(detail.retryDelay, true);
                        if (delay !== undefined)
                            return delay;
                    }
                }
            }
        }
        catch {
            // Malformed error bodies must not hide the original provider error.
        }
    }
    const message = getMessage(source);
    if (message.includes('https://ai.google.dev/')) {
        return parseSeconds(/Please retry in (\d+(?:\.\d+)?)s\./.exec(message)?.[1]);
    }
    return undefined;
};
function parseSeconds(value, duration = false) {
    if (typeof value !== 'string')
        return undefined;
    const match = (duration ? /^(\d+(?:\.\d+)?)s$/ : /^(\d+(?:\.\d+)?)$/).exec(value.trim());
    if (!match)
        return undefined;
    const milliseconds = Math.ceil(Number(match[1]) * 1000);
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}
export function classifyUpstreamRetryableError(error) {
    const classification = classifyUpstreamError(error);
    if (classification.status === 429 && (classification.retryAfterMs ?? 0) > 60_000) {
        return { ...classification, retryable: false, reason: 'long-retry-delay' };
    }
    return classification;
}
function classifyUpstreamError(error) {
    if (error instanceof LongRetryDelayError) {
        // Retry-after > 60s — don't retry, the user would wait too long
        return { retryable: false, reason: 'long-retry-delay' };
    }
    if (error instanceof RateLimitError) {
        const retryAfterMs = getRetryAfterMs(error);
        if (retryAfterMs !== undefined && retryAfterMs > 60_000) {
            return { retryable: false, retryAfterMs, reason: 'long-retry-delay' };
        }
        return {
            retryable: true,
            status: parseStatus(error.status),
            retryAfterMs,
            reason: 'openai-sdk',
        };
    }
    if (error instanceof APIConnectionError ||
        error instanceof APIConnectionTimeoutError ||
        error instanceof InternalServerError) {
        return {
            retryable: true,
            status: parseStatus(error.status),
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
    const rawStatus = error.status ??
        error.statusCode ??
        error.code ??
        error.error?.status ??
        error.error?.statusCode ??
        error.error?.code;
    const status = parseStatus(rawStatus);
    if (status !== undefined) {
        return {
            retryable: status === 429 || status >= 500,
            status,
            retryAfterMs: getRetryAfterMs(error) ?? getRetryAfterMs(error.error),
            reason: 'generic-status',
        };
    }
    const rawCode = String(error.code ?? error.error?.code ?? '').toLowerCase();
    const rawType = String(error.metadata?.error_type ??
        error.error?.metadata?.error_type ??
        error.type ??
        error.error?.type ??
        '').toLowerCase();
    if (rawCode.includes('rate_limit') ||
        rawCode.includes('too_many_requests') ||
        rawType.includes('rate_limit') ||
        rawType.includes('too_many_requests')) {
        return {
            retryable: true,
            status: 429,
            retryAfterMs: getRetryAfterMs(error) ?? getRetryAfterMs(error.error),
            reason: 'rate-limit-code',
        };
    }
    const message = getMessage(error).toLowerCase();
    const retryable = RATE_LIMIT_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern));
    return {
        retryable,
        retryAfterMs: getRetryAfterMs(error) ?? getRetryAfterMs(error.error),
        ...(retryable ? { reason: 'rate-limit-message' } : {}),
    };
}
export function computeUpstreamRetryDelayMs({ retryAfterMs, attemptIndex, attemptNumber, random = Math.random, }) {
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
    throw new Error('computeUpstreamRetryDelayMs requires attemptIndex or attemptNumber when retryAfterMs is not provided');
}
//# sourceMappingURL=upstream-retry-policy.js.map