import { ModelBehaviorError } from '@openai/agents';
import { APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError } from 'openai';
import { OpenRouterError, OpenAICompatibleError } from '../providers/common/provider-errors.js';
import { ChainingTransportDowngradeError } from '../providers/fallback-responses-model.js';

export const MAX_HALLUCINATION_RETRIES = 2;
export const MAX_SUBAGENT_MODEL_RETRIES = 1;
export const MAX_TRANSIENT_RETRIES = 3;

/**
 * Returns true when the error is a transient upstream failure (429 / 5xx /
 * connection timeout) that is worth retrying automatically.
 */
export const isTransientRetryableError = (error: unknown): boolean => {
  if (
    error instanceof APIConnectionError ||
    error instanceof APIConnectionTimeoutError ||
    error instanceof InternalServerError ||
    error instanceof RateLimitError
  ) {
    return true;
  }

  if (error instanceof OpenRouterError && (error.status === 429 || error.status >= 500)) {
    return true;
  }

  if (error instanceof OpenAICompatibleError && (error.status === 429 || error.status >= 500)) {
    return true;
  }

  if (typeof error === 'string') {
    const lower = error.toLowerCase();
    if (lower === 'terminated' || lower.startsWith('terminated:')) {
      return true;
    }
  }

  if (error instanceof ChainingTransportDowngradeError) {
    return true;
  }

  if (error && typeof error === 'object') {
    const statusRaw = (error as any).status ?? (error as any).statusCode;
    const status = typeof statusRaw === 'number' ? statusRaw : parseInt(statusRaw, 10);
    if (Number.isInteger(status) && (status === 429 || status >= 500)) {
      return true;
    }
    const message = String((error as any).message || '').toLowerCase();
    if (message.includes('websocket connection closed before response completed')) {
      return message.includes('code=1006');
    }
    if (
      message.includes('rate limit') ||
      message.includes('too many requests') ||
      message.includes('rate_limit') ||
      message === 'terminated' ||
      message.startsWith('terminated:')
    ) {
      return true;
    }
  }

  return false;
};

export const isRecoverableModelError = (error: unknown): boolean => {
  if (!(error instanceof ModelBehaviorError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    (message.includes('tool') && message.includes('not found')) ||
    message.includes('model did not produce a final response') ||
    message.includes('parsing tool arguments') ||
    message.includes('valid json')
  );
};

export type RetryType = 'hallucination' | 'parsing_error' | 'behavior';

export interface RetryEventPayload {
  type: 'retry';
  toolName: string;
  attempt: number;
  maxRetries: number;
  errorMessage: string;
  retryType?: RetryType;
}

export interface RetryLogPayload {
  toolName: string;
  retryType: RetryType;
  attempt: number;
  maxRetries: number;
  errorMessage: string;
}

export type RecoverableRetryDecision =
  | { kind: 'no_retry' }
  | {
      kind: 'retry';
      message: string;
      toolName: string;
      retryType: RetryType;
      attempt: number;
      maxRetries: number;
    };

export type RetryDecision =
  | { kind: 'no_retry' }
  | {
      kind: 'retry';
      message: string;
      retryEvent: RetryEventPayload;
      logPayload: RetryLogPayload;
      attempt: number;
      /** If true, caller should update conversation store from the existing stream and may inject error context. */
      hadStream: boolean;
      /** True when stream produced no usable history; caller should inject error-context message. */
      shouldInjectErrorContext: boolean;
      errorContextMessage: string;
      nextRunOptions: { hallucinationRetryCount: number; skipUserMessage: boolean };
    };

/**
 * Decides whether a model error is recoverable and returns retry metadata only.
 * Useful for callers (e.g. subagent manager) that need retry classification
 * without parent-specific fields like hadStream or nextRunOptions.
 */
export const decideRecoverableModelRetry = (
  error: unknown,
  attemptCount: number,
  maxRetries: number = MAX_HALLUCINATION_RETRIES,
): RecoverableRetryDecision => {
  if (!isRecoverableModelError(error) || attemptCount >= maxRetries) {
    return { kind: 'no_retry' };
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const isHallucination = lower.includes('not found');
  const isParsingError = lower.includes('parsing tool arguments') || lower.includes('valid json');
  const toolName = isHallucination ? message.match(/Tool (\S+) not found/)?.[1] || 'unknown' : 'unknown';
  const retryType: RetryType = isHallucination ? 'hallucination' : isParsingError ? 'parsing_error' : 'behavior';

  return {
    kind: 'retry',
    message,
    toolName,
    retryType,
    attempt: attemptCount + 1,
    maxRetries,
  };
};

export const decideRetry = (
  error: unknown,
  attemptCount: number,
  hadStream: boolean,
  streamHistoryLength: number,
): RetryDecision => {
  const decision = decideRecoverableModelRetry(error, attemptCount);
  if (decision.kind === 'no_retry') {
    return { kind: 'no_retry' };
  }

  const { message, toolName, retryType, attempt } = decision;

  return {
    kind: 'retry',
    message,
    retryEvent: {
      type: 'retry',
      toolName: retryType === 'hallucination' ? toolName : 'model',
      attempt,
      maxRetries: MAX_HALLUCINATION_RETRIES,
      errorMessage: message,
      retryType,
    },
    logPayload: {
      toolName,
      retryType,
      attempt,
      maxRetries: MAX_HALLUCINATION_RETRIES,
      errorMessage: message,
    },
    attempt,
    hadStream,
    shouldInjectErrorContext: hadStream && streamHistoryLength === 0,
    errorContextMessage: `[System: Previous attempt failed with error: ${message}. Please retry with corrected output.]`,
    nextRunOptions: {
      hallucinationRetryCount: attempt,
      skipUserMessage: hadStream,
    },
  };
};
