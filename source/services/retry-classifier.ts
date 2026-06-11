import { decideRetry } from './conversation-retry-policy.js';
import type { ClassificationContext, ClassifiedFailure } from './retry-contracts.js';
import { extractHistoryLength } from './stream-snapshot.js';
import type { ConversationAgentClient } from './conversation-agent-client.js';

export class DefaultRetryClassifier {
  constructor(private agentClient: ConversationAgentClient, private random: () => number = Math.random) {
    void this.agentClient;
    void this.random;
  }

  classify(context: ClassificationContext): ClassifiedFailure {
    const { error, retryCounts, stream, maxModelRetries } = context;

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
