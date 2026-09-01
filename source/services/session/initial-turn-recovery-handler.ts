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
import { classifyProviderFailure } from '../retry/provider-failure-classification.js';
import { isRetryRecoveryBudgetExhaustedError } from '../retry/retry-recovery-budget.js';
import type { SessionInputPlanner } from './session-input-planner.js';
import type { TurnAttempt } from './turn-attempt.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import { skipsAutomaticReplayClaim } from '../retry/committed-tool-continuation.js';

export type InitialTurnRecoveryResult =
  | { kind: 'run'; instruction: NextRunInstruction; delayMs?: number; useStandardServiceTier?: boolean }
  | { kind: 'terminated' }
  | { kind: 'stale' };

export type InitialTurnRecoveryHandlerDeps = {
  breakChaining?: () => void;
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
  provider?: string;
  toolTracker?: Pick<SessionToolTracker, 'inspectCommittedToolContinuation'>;
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

    const committedToolContinuation = this.deps.toolTracker?.inspectCommittedToolContinuation();
    let classified = this.deps.retryClassifier.classify({
      error,
      retryCounts: attempt.retryCounts,
      stream,
      hasCommittedOutput: attempt.modelEventSeen,
      committedToolContinuation,
      maxTransientRetries: attempt.maxTransientRetries,
      maxModelRetries: attempt.maxModelRetries,
    });

    // Blocking fresh starts (subagents) exists to stop a task replaying from the
    // beginning, so it must not block a retry that provably replays nothing.
    // `chain_recovery` only severs the response chain and rebuilds the request
    // from full history, which already carries every completed tool result, so a
    // connect-time drop cannot re-run work. Every other kind can reach a plan
    // that does replay -- `model_retry` maps to `replay_turn` with
    // `rollbackUserMessage` -- and stays blocked.
    if (!this.deps.freshStartRetriesAllowed && !stream && classified.kind !== 'chain_recovery') {
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
      const providerFailure = classifyProviderFailure(error);
      const exhausted =
        !stream &&
        (isRetryRecoveryBudgetExhaustedError(error) ||
          (providerFailure.retryable &&
            providerFailure.errorKind !== 'authentication' &&
            providerFailure.errorKind !== 'cancelled'));
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
          journalSnapshot: attempt.initialJournalSnapshot,
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
      if (exhausted) {
        const providerName = this.deps.provider ?? 'provider';
        yield {
          type: 'retry_exhausted',
          provider: providerName,
          errorKind: providerFailure.errorKind,
          attempts: Math.max(1, attempt.retryCounts.transientRetryCount + 1),
          maxAttempts: attempt.maxTransientRetries + 1,
          message: `Could not reach ${providerName} after ${Math.max(
            1,
            attempt.retryCounts.transientRetryCount + 1,
          )} attempts. No model response was received.`,
          canRetry: true,
        };
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

    if (classified.kind === 'chain_recovery') {
      this.deps.breakChaining?.();
    }

    // model_retry (hallucination/parsing/behavior detection) is a distinct,
    // pre-existing retry policy with its own maxModelRetries cap. It is not a
    // provider transport failure, so it must not draw against or be capped by
    // the shared transport-recovery envelope -- doing so silently truncated
    // an established, independently-tested retry count (see the regression
    // test this comment sits next to in initial-turn-recovery-handler.test.ts).
    if (classified.kind === 'transient' || classified.kind === 'chain_recovery') {
      attempt.recoveryBudget.noteRetryableFailure();
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
      journalSnapshot: attempt.initialJournalSnapshot,
      addedUserMessage: attempt.addedUserMessage,
      stream,
    };
    // Only retry_fresh (service_tier_fallback/transient/chain_recovery/
    // transport_downgrade) draws against the automatic-replay budget.
    // replay_turn is produced exclusively by model_retry, which is excluded
    // for the same reason noted above.
    if (
      plan.kind === 'retry_fresh' &&
      ((!skipsAutomaticReplayClaim(classified, committedToolContinuation) &&
        !attempt.recoveryBudget.claimAutomaticReplay()) ||
        !attempt.recoveryBudget.claimPhysicalAttempt())
    ) {
      // Refusing the plan must still go through the same settlement path a
      // normal termination does -- open tool calls settle truthfully (not as
      // blind failures), and the chain is cleared so the next turn cannot
      // send a text-only continuation against a response still awaiting tool
      // output. Returning 'terminated' directly here (the original bug)
      // skipped all of that.
      const terminateResult = this.deps.recoveryExecutor.apply({
        plan: { kind: 'terminate', events: [] },
        state: recoveryState,
        retryCounts: attempt.retryCounts,
        maxModelRetries: attempt.maxModelRetries,
      });
      if (terminateResult.kind === 'terminated') {
        for (const event of terminateResult.events) {
          yield event;
        }
      }
      yield {
        type: 'retry_exhausted',
        provider: this.deps.provider ?? 'provider',
        errorKind: classifyProviderFailure(error).errorKind,
        attempts: attempt.recoveryBudget.physicalAttempts,
        maxAttempts: attempt.recoveryBudget.maxPhysicalAttempts,
        message: `Could not reach ${this.deps.provider ?? 'provider'} after ${
          attempt.recoveryBudget.physicalAttempts
        } attempts. No model response was received.`,
        canRetry: true,
      };
      this.#logFailure(error);
      return { kind: 'terminated' };
    }
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
      delayMs: classified.kind === 'transient' || classified.kind === 'chain_recovery' ? classified.delayMs : undefined,
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
