import {
  classifyUpstreamRetryableError,
  computeUpstreamRetryDelayMs,
} from '../services/retry/upstream-retry-policy.js';

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
    const classification = classifyUpstreamRetryableError(error);
    const isRetryable = retries > 0 && classification.retryable;
    if (!isRetryable) {
      throw error;
    }

    const attemptIndex = context.retryAttempts - retries;
    const delay = computeUpstreamRetryDelayMs({
      retryAfterMs: classification.retryAfterMs,
      attemptIndex,
      random: context.random,
    });

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
      ...(classification.status !== undefined && {
        status: classification.status,
      }),
    });

    context.onRetry?.();
    return execute(operation, retries - 1, context);
  }
}
