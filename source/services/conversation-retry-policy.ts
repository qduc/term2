import { ModelBehaviorError } from '@openai/agents';

export const MAX_HALLUCINATION_RETRIES = 2;

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
}

export interface RetryLogPayload {
  toolName: string;
  retryType: RetryType;
  attempt: number;
  maxRetries: number;
  errorMessage: string;
}

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

export const decideRetry = (
  error: unknown,
  attemptCount: number,
  hadStream: boolean,
  streamHistoryLength: number,
): RetryDecision => {
  if (!isRecoverableModelError(error) || attemptCount >= MAX_HALLUCINATION_RETRIES) {
    return { kind: 'no_retry' };
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const isHallucination = lower.includes('not found');
  const isParsingError = lower.includes('parsing tool arguments') || lower.includes('valid json');
  const toolName = isHallucination ? message.match(/Tool (\S+) not found/)?.[1] || 'unknown' : 'unknown';
  const retryType: RetryType = isHallucination ? 'hallucination' : isParsingError ? 'parsing_error' : 'behavior';
  const attempt = attemptCount + 1;

  return {
    kind: 'retry',
    message,
    retryEvent: {
      type: 'retry',
      toolName: isHallucination ? toolName : 'model',
      attempt,
      maxRetries: MAX_HALLUCINATION_RETRIES,
      errorMessage: message,
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
