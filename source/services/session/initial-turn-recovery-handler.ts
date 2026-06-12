import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { ConversationStore } from '../conversation/conversation-store.js';
import type { AgentStream } from '../agent-stream.js';
import type { GenerationGuard } from '../generation-guard.js';
import type { DefaultConversationRecoveryPolicy } from '../retry/recovery-policy.js';
import type { DefaultRecoveryExecutor } from '../retry/recovery-executor.js';
import type { DefaultRetryClassifier } from '../retry/retry-classifier.js';
import type { RetryEventPresenter } from '../retry/retry-event-presenter.js';
import type { NextRunInstruction, RecoveryState } from '../retry/retry-contracts.js';
import { describeError } from '../../utils/error-helpers.js';
import type { SessionInputPlanner } from './session-input-planner.js';
import type { TurnAttempt } from './turn-attempt.js';

export type InitialTurnRecoveryResult =
  | { kind: 'run'; instruction: NextRunInstruction; delayMs?: number; useStandardServiceTier?: boolean }
  | { kind: 'terminated' }
  | { kind: 'stale' };

export type InitialTurnRecoveryHandlerDeps = {
  conversationStore: ConversationStore;
  freshStartRetriesAllowed: boolean;
  generationGuard: GenerationGuard;
  inputPlanner: SessionInputPlanner;
  logger: ILoggingService;
  recoveryExecutor: DefaultRecoveryExecutor;
  recoveryPolicy: DefaultConversationRecoveryPolicy;
  retryClassifier: DefaultRetryClassifier;
  retryEventPresenter: RetryEventPresenter;
  sessionId: string;
};

export class InitialTurnRecoveryHandler {
  constructor(private readonly deps: InitialTurnRecoveryHandlerDeps) {}

  async *handle(ctx: {
    error: unknown;
    attempt: TurnAttempt;
    stream: AgentStream | null;
  }): AsyncGenerator<ConversationEvent, InitialTurnRecoveryResult, void> {
    const { error, attempt, stream } = ctx;

    if (!this.deps.generationGuard.isCurrent(attempt.token)) {
      return { kind: 'stale' };
    }

    let classified = this.deps.retryClassifier.classify({
      error,
      retryCounts: attempt.retryCounts,
      stream,
      maxTransientRetries: attempt.maxTransientRetries,
      maxModelRetries: attempt.maxModelRetries,
    });

    if (!this.deps.freshStartRetriesAllowed && !stream && classified.kind !== 'unrecoverable') {
      this.deps.logger.warn('Retry requires fresh start but fresh-start retries are disabled for this session', {
        eventType: 'retry.fresh_start_blocked',
        category: 'retry',
        phase: 'retry',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
        retryKind: classified.kind,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      classified = { kind: 'unrecoverable' };
    }

    if (classified.kind === 'unrecoverable') {
      const droppedUserMessage =
        attempt.addedUserMessage && !stream
          ? { text: attempt.turn.text, imageCount: attempt.turn.images?.length ?? 0 }
          : undefined;
      const plan = this.deps.recoveryPolicy.plan({
        failure: classified,
        gen: attempt.token,
        stream,
        retryCounts: attempt.retryCounts,
        maxModelRetries: attempt.maxModelRetries,
        freshStartRetriesAllowed: this.deps.freshStartRetriesAllowed,
      });
      const recoveryResult = this.deps.recoveryExecutor.apply({
        plan,
        state: {
          ledgerSnapshot: attempt.initialLedgerSnapshot,
          addedUserMessage: attempt.addedUserMessage,
          stream,
        },
        retryCounts: attempt.retryCounts,
        maxModelRetries: attempt.maxModelRetries,
      });

      this.deps.inputPlanner.recordSuccess(this.deps.conversationStore.getHistory(), {
        kind: 'full_history',
        previousInput: attempt.streamInput,
      });
      for (const event of recoveryResult.events) {
        yield event;
      }
      yield {
        type: 'error',
        message: describeError(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        ...(droppedUserMessage ? { droppedUserMessage } : {}),
      };
      this.#logFailure(error);
      return { kind: 'terminated' };
    }

    const presentation = this.deps.retryEventPresenter.present({
      failure: classified,
      maxTransientRetries: attempt.maxTransientRetries,
      maxModelRetries: attempt.maxModelRetries,
      source: 'initial',
      error,
    });
    yield presentation.event;

    this.deps.logger.warn(presentation.logMessage, {
      ...presentation.logFields,
      sessionId: this.deps.sessionId,
      traceId: this.deps.logger.getCorrelationId(),
    });

    if (!this.deps.generationGuard.isCurrent(attempt.token)) {
      return { kind: 'stale' };
    }

    attempt.advanceRetry(this.deps.recoveryPolicy.nextRetryCounts(attempt.retryCounts, classified));
    const plan = this.deps.recoveryPolicy.plan({
      failure: classified,
      gen: attempt.token,
      stream,
      retryCounts: attempt.retryCounts,
      maxModelRetries: attempt.maxModelRetries,
      freshStartRetriesAllowed: this.deps.freshStartRetriesAllowed,
    });
    const recoveryState: RecoveryState = {
      ledgerSnapshot: attempt.initialLedgerSnapshot,
      addedUserMessage: attempt.addedUserMessage,
      stream,
    };
    const result = this.deps.recoveryExecutor.apply({
      plan,
      state: recoveryState,
      retryCounts: attempt.retryCounts,
      maxModelRetries: attempt.maxModelRetries,
    });

    if (result.kind === 'terminated') {
      for (const event of result.events) {
        yield event;
      }
      yield {
        type: 'error',
        message: describeError(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      };
      this.#logFailure(error);
      return { kind: 'terminated' };
    }

    return {
      kind: 'run',
      instruction: result.instruction,
      delayMs: classified.kind === 'transient' ? classified.delayMs : undefined,
      useStandardServiceTier: result.useStandardServiceTier,
    };
  }

  #logFailure(error: unknown): void {
    this.deps.logger.error('Conversation stream error', {
      eventType: 'stream.failed',
      category: 'stream',
      phase: 'abort',
      sessionId: this.deps.sessionId,
      traceId: this.deps.logger.getCorrelationId(),
      errorMessage: describeError(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}
