import { APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError } from 'openai';
import { OpenRouterError, OpenAICompatibleError } from '../providers/common/provider-errors.js';

type RetryLogger = {
  warn(message: string, meta?: Record<string, unknown>): void;
};

export async function executeWithRetry<T>({
  operation,
  retryAttempts,
  provider,
  model,
  traceId,
  logger,
  onRetry,
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
}: {
  operation: () => Promise<T>;
  retryAttempts: number;
  provider: string;
  model: string;
  traceId?: string | null;
  logger: RetryLogger;
  onRetry?: () => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): Promise<T> {
  return execute(operation, retryAttempts, {
    retryAttempts,
    provider,
    model,
    traceId,
    logger,
    onRetry,
    sleep,
    random,
  });
}

async function execute<T>(
  operation: () => Promise<T>,
  retries: number,
  context: {
    retryAttempts: number;
    provider: string;
    model: string;
    traceId?: string | null;
    logger: RetryLogger;
    onRetry?: () => void;
    sleep: (ms: number) => Promise<void>;
    random: () => number;
  },
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const isTransientError =
      error instanceof APIConnectionError ||
      error instanceof APIConnectionTimeoutError ||
      error instanceof InternalServerError ||
      error instanceof RateLimitError;

    const isOpenRouterRetryable = error instanceof OpenRouterError && (error.status === 429 || error.status >= 500);
    const isOpenAICompatibleRetryable =
      error instanceof OpenAICompatibleError && (error.status === 429 || error.status >= 500);

    const isGenericRetryable = (() => {
      if (!error || typeof error !== 'object') return false;
      const statusRaw = (error as any).status ?? (error as any).statusCode;
      const status = typeof statusRaw === 'number' ? statusRaw : parseInt(statusRaw, 10);
      if (Number.isInteger(status)) {
        return status === 429 || status >= 500;
      }
      const message = String((error as any).message || '').toLowerCase();
      return message.includes('rate limit') || message.includes('too many requests') || message.includes('rate_limit');
    })();

    const isRetryable =
      retries > 0 && (isTransientError || isOpenRouterRetryable || isOpenAICompatibleRetryable || isGenericRetryable);
    if (!isRetryable) {
      throw error;
    }

    const attemptIndex = context.retryAttempts - retries;
    const getHeader = (err: any, name: string): string | undefined => {
      if (!err || typeof err !== 'object') return undefined;
      const headers = err.headers;
      if (!headers) return undefined;
      if (typeof headers.get === 'function') {
        return headers.get(name) || undefined;
      }
      if (typeof headers === 'object') {
        const search = name.toLowerCase();
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === search) {
            return headers[key];
          }
        }
      }
      return undefined;
    };

    const retryAfterHeader =
      (error instanceof RateLimitError && error.headers?.['retry-after']) ||
      (error instanceof OpenRouterError && error.headers['retry-after']) ||
      (error instanceof OpenAICompatibleError && error.headers['retry-after']) ||
      getHeader(error, 'retry-after');

    let delay: number;
    if (retryAfterHeader) {
      delay = parseInt(retryAfterHeader, 10) * 1000;
    } else {
      const baseDelay = 500 + context.random() * 500;
      const exponentialDelay = baseDelay * Math.pow(2, attemptIndex);
      const cappedDelay = Math.min(exponentialDelay, 30000);
      delay = context.random() * cappedDelay;
    }

    await context.sleep(delay);

    const status = (() => {
      if (error instanceof OpenRouterError || error instanceof OpenAICompatibleError) {
        return error.status;
      }
      if (!error || typeof error !== 'object') return undefined;
      const statusRaw = (error as any).status ?? (error as any).statusCode;
      const statusNum = typeof statusRaw === 'number' ? statusRaw : parseInt(statusRaw, 10);
      return Number.isInteger(statusNum) ? statusNum : undefined;
    })();

    context.logger.warn('Agent operation retry', {
      eventType: 'retry.upstream',
      category: 'retry',
      phase: 'retry',
      traceId: context.traceId,
      provider: context.provider,
      model: context.model,
      retryType: 'upstream',
      retryAttempt: attemptIndex + 1,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      retriesRemaining: retries - 1,
      delayMs: Math.round(delay),
      attemptIndex,
      errorMessage: error instanceof Error ? error.message : String(error),
      ...(status !== undefined && {
        status,
      }),
    });

    context.onRetry?.();
    return execute(operation, retries - 1, context);
  }
}
