import { decideRetry } from './conversation-retry-policy.js';
import {
  isMissingServerToolOutputError,
  isPreviousResponseNotFoundError,
  isRecoverableIncompleteStreamClose,
  isRetryableTransportError,
  isTransientRetryableError,
  isWebSocketConnectionLimitReachedError,
} from './retry-error-classification.js';
import { classifyUpstreamRetryableError } from './upstream-retry-policy.js';
import type { ClassificationContext, ClassifiedFailure } from './retry-contracts.js';
import { AmbiguousModelOutcomeError, ConversationStateNoProgressError } from './retry-errors.js';
import { extractHistoryLength } from '../stream-snapshot.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import { isMissingChainedToolOutputError, isOrphanedChainedToolOutputError } from '../../lib/chained-input-filter.js';

const TRANSIENT_BASE_DELAY_MS = 500;
const TRANSIENT_MAX_DELAY_MS = 30_000;
const MAX_TRANSPORT_DOWNGRADES = 1;

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

    // Once the application has emitted any model event, the request may have
    // produced user-visible or externally meaningful work. Never replay that
    // partial turn automatically; the recovery executor still settles its tool
    // ledger truthfully before termination.
    if (
      context.hasCommittedOutput ||
      (stream && ((stream.output?.length ?? 0) > 0 || (stream.newItems?.length ?? 0) > 0))
    ) {
      return { kind: 'unrecoverable' };
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

    if (error instanceof ConversationStateNoProgressError) {
      return { kind: 'unrecoverable' };
    }

    if (
      isPreviousResponseNotFoundError(error) ||
      isMissingServerToolOutputError(error) ||
      isMissingChainedToolOutputError(error) ||
      isOrphanedChainedToolOutputError(error)
    ) {
      const nextAttempt = retryCounts.transientRetryCount + 1;
      if (nextAttempt > maxTransientRetries) {
        return { kind: 'unrecoverable' };
      }
      return {
        kind: 'chain_recovery',
        attempt: nextAttempt,
        delayMs: computeTransientDelayMs(nextAttempt, this.random),
      };
    }

    // A stream cut before its terminal event is wrapped as ambiguous because it
    // may already have been accepted server-side, and `isRetryableTransportError`
    // refuses every ambiguous error — replaying against the open chain is unsafe.
    // Chain recovery does not replay: it rebuilds from full history. Route the
    // recoverable closes there rather than ending the run on one flaky drop.
    if (error instanceof AmbiguousModelOutcomeError) {
      if (isRecoverableIncompleteStreamClose(error)) {
        const nextAttempt = retryCounts.transientRetryCount + 1;
        if (nextAttempt > maxTransientRetries) {
          return { kind: 'unrecoverable' };
        }
        return {
          kind: 'chain_recovery',
          attempt: nextAttempt,
          delayMs: computeTransientDelayMs(nextAttempt, this.random),
        };
      }
      return { kind: 'unrecoverable' };
    }

    if (isWebSocketConnectionLimitReachedError(error)) {
      // A new connection can repair the provider's hard WebSocket lifetime
      // limit once. Repeating the same fallback cannot make progress.
      if (retryCounts.transportDowngradeCount >= MAX_TRANSPORT_DOWNGRADES) {
        return { kind: 'unrecoverable' };
      }
      return { kind: 'transport_downgrade' };
    }

    const upstream = classifyUpstreamRetryableError(error);
    if (isRetryableTransportError(error).retryable || isTransientRetryableError(error) || upstream.retryable) {
      const nextAttempt = retryCounts.transientRetryCount + 1;
      if (nextAttempt > maxTransientRetries) {
        return { kind: 'unrecoverable' };
      }
      const delayMs = upstream.retryAfterMs ?? computeTransientDelayMs(nextAttempt, this.random);
      return { kind: 'transient', attempt: nextAttempt, delayMs };
    }

    return { kind: 'unrecoverable' };
  }
}
