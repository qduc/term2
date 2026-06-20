import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { ShellAutoApprovalResolver } from '../approval/shell-auto-approval-resolver.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { TurnItemAccumulator } from './turn-item-accumulator.js';
import type { GenerationGuard } from '../generation-guard.js';
import { TurnAttempt } from './turn-attempt.js';
import { getMethod } from '../interruption-info.js';
import type { UserTurn } from '../../types/user-turn.js';
import type { InitialTurnRunOptions, TurnAttemptFactory } from './turn-attempt-factory.js';
import type { InitialInputPreparer } from './initial-input-preparer.js';
import type { InitialStreamCycle } from './initial-stream-cycle.js';
import type { InitialTurnRecoveryHandler } from './initial-turn-recovery-handler.js';
import type { AssistantTurnJournal } from '../logging/assistant-turn-journal.js';
import type { InitialTurnControlOutcome, StreamingTurnOutcome } from './turn-transition.js';

export type InitialTurnOutcome = StreamingTurnOutcome | InitialTurnControlOutcome;

export interface InitialTurnRunnerDeps {
  agentClient: ConversationAgentClient;
  logger: ILoggingService;
  sessionId: string;
  turnAccumulator: TurnItemAccumulator;
  toolTracker: SessionToolTracker;
  shellAutoApproval: ShellAutoApprovalResolver;
  generationGuard: GenerationGuard;
  attemptFactory: TurnAttemptFactory;
  inputPreparer: InitialInputPreparer;
  streamCycle: InitialStreamCycle;
  recoveryHandler: InitialTurnRecoveryHandler;
  getJournal?: () => AssistantTurnJournal | undefined;
}

export class InitialTurnRunner {
  constructor(private readonly deps: InitialTurnRunnerDeps) {}

  async *run(
    attemptOrInput: TurnAttempt | string | UserTurn,
    options: InitialTurnRunOptions = {},
  ): AsyncGenerator<ConversationEvent, InitialTurnOutcome, void> {
    let attempt: TurnAttempt;
    if (attemptOrInput instanceof TurnAttempt) {
      attempt = attemptOrInput;
    } else {
      const creation = this.deps.attemptFactory.create(attemptOrInput, options);
      if (creation.kind === 'stale') {
        return { kind: 'stale' };
      }
      attempt = creation.attempt;
    }

    let skipUser = options.skipUserMessage ?? false;
    let currentResumeState = options.resumeState;
    let currentResumePreviousResponseId = options.resumePreviousResponseId;
    let currentAbortedContext = options.abortedContext ?? null;

    const initialCounts = attempt.retryCounts;
    if (
      !skipUser ||
      initialCounts.modelRetryCount > 0 ||
      initialCounts.serviceTierFallbackCount > 0 ||
      initialCounts.transientRetryCount > 0 ||
      initialCounts.transportDowngradeCount > 0
    ) {
      this.deps.turnAccumulator.resetPersistedTurnState();
    }

    try {
      if (options.delayMs && options.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (!this.deps.generationGuard.isCurrent(attempt.token)) {
        return { kind: 'stale' };
      }
      if (options.useStandardServiceTier) {
        getMethod<[], void>(this.deps.agentClient, 'useStandardServiceTierForNextRequest')?.call(this.deps.agentClient);
      }

      this.deps.toolTracker.ledger.beginTurn();
      this.deps.getJournal?.()?.resetForNewTurn();

      while (true) {
        // 1. Check generation token validity
        if (currentAbortedContext) {
          const tokenVal = currentAbortedContext.token ?? 0;
          if (!this.deps.generationGuard.isCurrent(tokenVal)) {
            return { kind: 'stale' };
          }
        } else {
          if (!this.deps.generationGuard.isCurrent(attempt.token)) {
            return { kind: 'stale' };
          }
        }

        // 2. Handle aborted-approval resolution
        if (currentAbortedContext) {
          if (!skipUser) {
            yield { type: 'user_message_consumed_for_abort' };
          }
          this.deps.logger.debug('Resolving aborted approval with fake execution', {
            message: attempt.turn.text,
          });

          // Return outcome instead of calling ContinuationDriver
          return {
            kind: 'abort_resolution_required',
            abortedContext: currentAbortedContext,
            userText: attempt.turn.text,
            generation: attempt.token,
          };
        }

        const preparation = this.deps.inputPreparer.prepare(attempt, skipUser, options);
        if (preparation.kind === 'blocked') {
          yield preparation.event;
          return { kind: 'failed' };
        }

        try {
          const cycleResult = yield* this.deps.streamCycle.execute(attempt, {
            resumeState: currentResumeState,
            resumePreviousResponseId: currentResumePreviousResponseId,
          });
          if (cycleResult.kind === 'stale') {
            return { kind: 'stale' };
          }
          const { outcome } = cycleResult;

          if (outcome.kind === 'response') {
            return { kind: 'response', terminal: outcome.result };
          }

          if (outcome.kind === 'auto_approve') {
            this.deps.logger.debug('Shell command auto-approved by LLM', {
              eventType: 'approval.auto_approved',
              category: 'approval',
              phase: 'approval',
              sessionId: this.deps.sessionId,
              traceId: this.deps.logger.getCorrelationId(),
              callId: outcome.callId,
              command: outcome.argumentsText,
              model: outcome.advisory?.model,
              reasoning: outcome.advisory?.reasoning,
            });

            // Return outcome instead of calling ContinuationDriver
            return {
              kind: 'auto_approval_required',
              generation: attempt.token,
              callId: outcome.callId,
              command: outcome.argumentsText,
            };
          }

          if (outcome.result.approval.callId) {
            this.deps.toolTracker.recordFunctionCall({
              type: 'function_call',
              callId: outcome.result.approval.callId,
              name: outcome.result.approval.toolName,
              arguments: outcome.result.approval.argumentsText,
            });
          }
          this.deps.logger.debug('Tool approval required', {
            eventType: 'approval.required',
            category: 'approval',
            phase: 'approval',
            sessionId: this.deps.sessionId,
            traceId: this.deps.logger.getCorrelationId(),
            toolName: outcome.result.approval.toolName,
          });
          return { kind: 'approval_required', terminal: outcome.result };
        } catch (error) {
          const handled = yield* this.deps.recoveryHandler.handle({
            error,
            attempt,
            stream: attempt.stream,
          });

          if (handled.kind === 'run') {
            skipUser = handled.instruction.skipUserMessage;
            currentResumeState = handled.instruction.resumeState;
            currentResumePreviousResponseId = handled.instruction.resumePreviousResponseId;
            currentAbortedContext = null;
            if (handled.delayMs && handled.delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, handled.delayMs));
            }
            if (handled.useStandardServiceTier) {
              getMethod<[], void>(this.deps.agentClient, 'useStandardServiceTierForNextRequest')?.call(
                this.deps.agentClient,
              );
            }
            continue;
          } else if (handled.kind === 'stale') {
            return { kind: 'stale' };
          } else {
            throw error;
          }
        }
      }
    } finally {
      attempt.close();
    }
  }
}
