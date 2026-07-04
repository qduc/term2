import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { GenerationGuard } from '../generation-guard.js';
import type { DefaultRetryClassifier } from '../retry/retry-classifier.js';
import type { DefaultConversationRecoveryPolicy } from '../retry/recovery-policy.js';
import type { DefaultRecoveryExecutor } from '../retry/recovery-executor.js';
import type { RetryEventPresenter } from '../retry/retry-event-presenter.js';
import type { RetryCounts, RecoveryState } from '../retry/retry-contracts.js';
import type { ContinuationState } from './continuation-state.js';
import type { SessionToolTracker } from './session-tool-tracker.js';

export type ContinuationRecoveryHandlerDeps = {
  logger: ILoggingService;
  sessionId: string;
  generationGuard: GenerationGuard;
  retryClassifier: DefaultRetryClassifier;
  recoveryPolicy: DefaultConversationRecoveryPolicy;
  recoveryExecutor: DefaultRecoveryExecutor;
  retryEventPresenter: RetryEventPresenter;
  resolveRetryLimit: () => number;
  toolTracker: SessionToolTracker;
};

export type ContinuationRecoveryResult =
  | { kind: 'stale' }
  | { kind: 'terminated' }
  | { kind: 'resume' }
  | { kind: 'fresh_start'; retryCounts: RetryCounts; delayMs?: number; useStandardServiceTier?: boolean };

export class ContinuationRecoveryHandler {
  constructor(private readonly deps: ContinuationRecoveryHandlerDeps) {}

  async *handle(ctx: {
    error: unknown;
    state: ContinuationState;
  }): AsyncGenerator<ConversationEvent, ContinuationRecoveryResult, void> {
    const { error, state } = ctx;
    const maxTransientRetries = this.deps.resolveRetryLimit();
    const retryStream = state.lastStream;

    const classified = this.deps.retryClassifier.classify({
      error,
      retryCounts: state.retryCounts,
      stream: retryStream,
      maxTransientRetries,
    });

    if (classified.kind === 'unrecoverable') {
      return { kind: 'terminated' };
    }

    const presentation = this.deps.retryEventPresenter.present({
      failure: classified,
      maxTransientRetries,
      source: 'continuation',
      error,
    });

    yield presentation.event;

    this.deps.logger.warn(presentation.logMessage, {
      ...presentation.logFields,
      sessionId: this.deps.sessionId,
      traceId: this.deps.logger.getCorrelationId(),
    });

    if (!this.deps.generationGuard.isCurrent(state.token)) {
      return { kind: 'stale' };
    }

    const nextRetryCounts = this.deps.recoveryPolicy.nextRetryCounts(state.retryCounts, classified);
    state.setRetryCounts(nextRetryCounts);

    const plan = this.deps.recoveryPolicy.plan({
      failure: classified,
      gen: state.token,
      stream: retryStream,
      retryCounts: state.retryCounts,
      freshStartRetriesAllowed: true,
    });

    const recoveryState: RecoveryState = {
      journalSnapshot: state.journalSnapshot,
      addedUserMessage: false,
      stream: retryStream,
      currentState: state.currentState,
      toolResultCallIds: state.currentCallIds,
    };
    const transientDelayMs = classified.kind === 'transient' ? classified.delayMs : undefined;

    const recoveryResult = this.deps.recoveryExecutor.apply({
      plan,
      state: recoveryState,
      retryCounts: state.retryCounts,
    });

    if (recoveryResult.kind === 'terminated') {
      return { kind: 'terminated' };
    }

    if (recoveryResult.instruction.resumeState) {
      if (typeof transientDelayMs === 'number' && transientDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, transientDelayMs));
        if (!this.deps.generationGuard.isCurrent(state.token)) {
          return { kind: 'stale' };
        }
      }
      state.currentState = recoveryResult.instruction.resumeState;
      state.setResumePreviousResponseId(recoveryResult.instruction.resumePreviousResponseId);
      return { kind: 'resume' };
    }

    return {
      kind: 'fresh_start',
      retryCounts: state.retryCounts,
      ...(typeof transientDelayMs === 'number' ? { delayMs: transientDelayMs } : {}),
      ...(recoveryResult.useStandardServiceTier ? { useStandardServiceTier: true } : {}),
    };
  }
}
