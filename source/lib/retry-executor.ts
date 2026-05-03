import { APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError } from 'openai';
import { OpenRouterError } from '../providers/openrouter.js';
import { OpenAICompatibleError } from '../providers/openai-compatible/api.js';

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

    const isRetryable = retries > 0 && (isTransientError || isOpenRouterRetryable || isOpenAICompatibleRetryable);
    if (!isRetryable) {
      throw error;
    }

    const attemptIndex = context.retryAttempts - retries;
    const retryAfterHeader =
      (error instanceof RateLimitError && error.headers?.['retry-after']) ||
      (error instanceof OpenRouterError && error.headers['retry-after']) ||
      (error instanceof OpenAICompatibleError && error.headers['retry-after']);

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
      ...(error instanceof OpenRouterError && {
        status: error.status,
      }),
      ...(error instanceof OpenAICompatibleError && {
        status: error.status,
      }),
    });

    context.onRetry?.();
    return execute(operation, retries - 1, context);
  }
}
