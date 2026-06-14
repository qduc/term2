import { decideRetry } from './conversation-retry-policy.js';
import { isPreviousResponseNotFoundError, isRetryableTransportError } from './retry-error-classification.js';
import type { ClassificationContext, ClassifiedFailure } from './retry-contracts.js';
import { extractHistoryLength } from '../stream-snapshot.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';

const TRANSIENT_BASE_DELAY_MS = 500;
const TRANSIENT_MAX_DELAY_MS = 30_000;

const computeTransientDelayMs = (attempt: number, random: () => number): number => {
  const baseDelay = Math.min(TRANSIENT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), TRANSIENT_MAX_DELAY_MS);
  const jitter = 0.9 + random() * 0.2;
  return Math.round(baseDelay * jitter);
};

export class DefaultRetryClassifier {
  constructor(private agentClient: ConversationAgentClient, private random: () => number = Math.random) {
    void this.agentClient;
  }

  classify(context: ClassificationContext): ClassifiedFailure {
    const { error, retryCounts, stream, maxTransientRetries, maxModelRetries } = context;

    const hallucinationDecision = decideRetry(
      error,
      retryCounts.modelRetryCount,
      Boolean(stream),
      extractHistoryLength(stream),
      maxModelRetries,
    );
    if (hallucinationDecision.kind === 'retry') {
      return {
        kind: 'model_retry',
        errorContext: hallucinationDecision.shouldInjectErrorContext
          ? hallucinationDecision.errorContextMessage
          : undefined,
        retryEvent: hallucinationDecision.retryEvent,
      };
    }

    if (isPreviousResponseNotFoundError(error)) {
      const nextAttempt = retryCounts.transientRetryCount + 1;
      if (nextAttempt > maxTransientRetries) {
        return { kind: 'unrecoverable' };
      }
      return { kind: 'transport_downgrade' };
    }

    if (isRetryableTransportError(error).retryable) {
      const nextAttempt = retryCounts.transientRetryCount + 1;
      if (nextAttempt > maxTransientRetries) {
        return { kind: 'unrecoverable' };
      }
      return { kind: 'transient', attempt: nextAttempt, delayMs: computeTransientDelayMs(nextAttempt, this.random) };
    }

    return { kind: 'unrecoverable' };
  }
}
