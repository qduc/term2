import { decideRetry, isTransientRetryableError } from './conversation-retry-policy.js';
import type { ClassificationContext, ClassifiedFailure } from './retry-contracts.js';
import { classifyUpstreamRetryableError, computeUpstreamRetryDelayMs } from './upstream-retry-policy.js';
import { extractHistoryLength } from './stream-snapshot.js';
import type { ConversationAgentClient } from './conversation-agent-client.js';

export class DefaultRetryClassifier {
  constructor(private agentClient: ConversationAgentClient, private random: () => number = Math.random) {}

  classify(context: ClassificationContext): ClassifiedFailure {
    const { error, retryCounts, stream, maxTransientRetries, maxModelRetries } = context;

    const shouldRetryWithoutFlexServiceTier =
      typeof this.agentClient.shouldRetryWithoutFlexServiceTier === 'function'
        ? this.agentClient.shouldRetryWithoutFlexServiceTier(error)
        : false;

    if (shouldRetryWithoutFlexServiceTier && retryCounts.serviceTierFallbackCount === 0) {
      return { kind: 'service_tier_fallback' };
    }

    const transientRetryable = isTransientRetryableError(error);

    if (transientRetryable && retryCounts.transientRetryCount < maxTransientRetries) {
      const attempt = retryCounts.transientRetryCount + 1;
      const upstreamRetryClassification = classifyUpstreamRetryableError(error);
      return {
        kind: 'transient',
        attempt,
        delayMs: computeUpstreamRetryDelayMs({
          retryAfterMs: upstreamRetryClassification.retryAfterMs,
          attemptNumber: attempt,
          random: this.random,
        }),
      };
    }

    if (transientRetryable && retryCounts.transportDowngradeCount < 1) {
      const forceTransportDowngrade =
        typeof this.agentClient.forceTransportDowngrade === 'function'
          ? this.agentClient.forceTransportDowngrade(error)
          : false;
      if (forceTransportDowngrade) {
        return { kind: 'transport_downgrade' };
      }
    }

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

    return { kind: 'unrecoverable' };
  }
}
