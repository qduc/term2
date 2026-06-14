import type { ClassifiedFailure } from './retry-contracts.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';

export type RetryEventPresenterInput = {
  failure: ClassifiedFailure;
  maxTransientRetries: number;
  maxModelRetries?: number;
  source: 'initial' | 'continuation';
  error: unknown;
};

export type RetryPresentation = {
  event: ConversationEvent;
  logMessage: string;
  logFields: Record<string, any>;
};

export class RetryEventPresenter {
  present(input: RetryEventPresenterInput): RetryPresentation {
    const { failure, maxTransientRetries, maxModelRetries, source, error } = input;
    const errorMessage = error instanceof Error ? error.message : String(error);

    switch (failure.kind) {
      case 'service_tier_fallback': {
        const event: ConversationEvent = {
          type: 'retry',
          toolName: 'service_tier',
          attempt: 1,
          maxRetries: 1,
          errorMessage: 'Flex service tier timed out. Falling back to standard service tier and retrying.',
          retryType: 'flex_service_tier',
        };
        const logMessage = 'Flex service tier timed out, retrying with standard service tier';
        const logFields = {
          eventType: 'retry.flex_service_tier',
          retryType: 'flex_service_tier',
          retryAttempt: 1,
          maxRetries: 1,
          errorMessage,
        };
        return { event, logMessage, logFields };
      }

      case 'transient': {
        const toolName = source === 'continuation' ? 'continuation' : 'turn';
        const event: ConversationEvent = {
          type: 'retry',
          toolName,
          attempt: failure.attempt,
          maxRetries: maxTransientRetries,
          errorMessage,
          retryType: 'upstream',
        };
        const logMessage =
          source === 'continuation'
            ? 'Transient error in continuation, retrying'
            : 'Transient upstream error detected, retrying turn';
        const logFields = {
          eventType: 'retry.transient',
          retryType: 'upstream',
          retryAttempt: failure.attempt,
          maxRetries: maxTransientRetries,
          errorMessage,
          delayMs: failure.delayMs,
        };
        return { event, logMessage, logFields };
      }

      case 'transport_downgrade': {
        const event: ConversationEvent = {
          type: 'retry',
          toolName: 'transport',
          attempt: 1,
          maxRetries: 1,
          errorMessage: 'WebSocket retries exhausted. Falling back to HTTP transport and retrying.',
          retryType: 'upstream',
        };
        const logMessage = 'Transient upstream error exhausted WS retries, forcing HTTP fallback';
        const logFields = {
          eventType: 'retry.transport_fallback',
          retryType: 'upstream',
          retryAttempt: 1,
          maxRetries: 1,
          errorMessage,
        };
        return { event, logMessage, logFields };
      }

      case 'model_retry': {
        const event: ConversationEvent = failure.retryEvent ?? {
          type: 'retry',
          toolName: 'model',
          attempt: 1,
          maxRetries: maxModelRetries ?? 3,
          errorMessage,
          retryType: 'behavior',
        };
        const logMessage = 'Recoverable model error detected, retrying';
        const logFields = {
          eventType: 'retry.model_error',
          retryType: 'hallucination',
          retryAttempt: 1,
          maxRetries: maxModelRetries ?? 3,
          errorMessage,
        };
        return { event, logMessage, logFields };
      }

      default: {
        const toolName = source === 'continuation' ? 'continuation' : 'turn';
        const event: ConversationEvent = {
          type: 'retry',
          toolName,
          attempt: 1,
          maxRetries: maxTransientRetries,
          errorMessage,
          retryType: 'upstream',
        };
        const logMessage = 'Unknown retry decision';
        const logFields = {
          eventType: 'retry.unknown',
          retryType: 'upstream',
          retryAttempt: 1,
          maxRetries: maxTransientRetries,
          errorMessage,
        };
        return { event, logMessage, logFields };
      }
    }
  }
}
