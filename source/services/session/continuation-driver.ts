import type { ILoggingService } from '../service-interfaces.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ConversationTerminal, LLMAdvisory } from '../../contracts/conversation.js';
import type { AbortedApprovalContext } from '../approval/approval-state.js';
import { GenerationGuard } from '../generation-guard.js';
import type { ApprovalDecisionPolicy } from '../approval/approval-decision-policy.js';
import { ShellAutoApprovalDecisionPolicy } from '../approval/approval-decision-policy.js';
import type { ConversationStore } from '../conversation/conversation-store.js';
import type { SessionInputPlanner } from './session-input-planner.js';
import type { ApprovalFlowCoordinator } from '../approval/approval-flow-coordinator.js';
import type { ShellAutoApprovalResolver } from '../approval/shell-auto-approval-resolver.js';
import { describeError } from '../../utils/error-helpers.js';
import type { RetryCounts, RecoveryInstructions } from '../retry/retry-contracts.js';
import { getToolInfoFromInterruption, getCallIdFromObject } from '../interruption-info.js';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { ContinuationPlanApplier } from './continuation-plan-applier.js';
import type { ContinuationStreamCycle } from './continuation-stream-cycle.js';
import type { ContinuationRecoveryHandler } from './continuation-recovery-handler.js';
import { ContinuationState } from './continuation-state.js';

export type ContinuationInit =
  | {
      kind: 'approval_decision';
      answer: string;
      rejectionReason?: string;
      generation: number;
    }
  | {
      kind: 'abort_resolution';
      abortedContext: AbortedApprovalContext;
      userText: string;
      generation: number;
    };

export type ContinuationDriveResult =
  | { kind: 'approval_required'; result: ConversationTerminal }
  | { kind: 'response'; result: ConversationTerminal }
  | ({ kind: 'fresh_start_required'; retryCounts: RetryCounts } & RecoveryInstructions)
  | { kind: 'stale' };

export interface ContinuationDriverDeps {
  generationGuard: GenerationGuard;
  logger: ILoggingService;
  sessionId: string;
  shellAutoApproval: ShellAutoApprovalResolver;
  inputPlanner: SessionInputPlanner;
  conversationStore: ConversationStore;
  approvalFlow: ApprovalFlowCoordinator;
  planApplier: ContinuationPlanApplier;
  streamCycle: ContinuationStreamCycle;
  recoveryHandler: ContinuationRecoveryHandler;
}

export class ContinuationDriver {
  constructor(private readonly deps: ContinuationDriverDeps) {}

  async *drive(
    init: ContinuationInit,
    policy?: ApprovalDecisionPolicy,
  ): AsyncGenerator<ConversationEvent, ContinuationDriveResult, void> {
    const activePolicy = policy ?? new ShellAutoApprovalDecisionPolicy(this.deps.shellAutoApproval);

    if (!this.deps.generationGuard.isCurrent(init.generation)) {
      return { kind: 'stale' };
    }

    const prepared = this.deps.planApplier.prepareInit(init);
    const state = new ContinuationState(init.generation);
    state.initializeFrom(prepared);

    try {
      yield* this.deps.planApplier.applyInitialSetup(prepared, state);

      while (true) {
        if (!this.deps.generationGuard.isCurrent(state.token)) {
          return { kind: 'stale' };
        }

        try {
          const previousInputForSurge =
            state.inputMode === 'full_history' ? this.deps.conversationStore.getHistory() : undefined;

          const cycleResult = yield* this.deps.streamCycle.execute(state);

          if (cycleResult.kind === 'stale') {
            return { kind: 'stale' };
          }

          const { outcome, nextCumulativeMessages, nextCumulativeUsage, nextCumulativeTurnItems, mergedEmittedIds } =
            cycleResult;

          state.setCumulativeUsage(nextCumulativeUsage);
          state.setCumulativeCommandMessages(nextCumulativeMessages);
          state.setCumulativeTurnItems(nextCumulativeTurnItems);

          if (outcome.kind === 'response') {
            this.#recordSuccess(state, previousInputForSurge);
            return { kind: 'response', result: this.#buildResponse(outcome.result, nextCumulativeUsage) };
          }

          const approvalResult = await this.#handleApprovalOutcome(
            outcome,
            state,
            activePolicy,
            nextCumulativeUsage,
            previousInputForSurge,
          );
          if (approvalResult.action === 'return') {
            return approvalResult.result;
          }
          if (approvalResult.action === 'loop') {
            yield* this.deps.planApplier.applyNextPlan(
              approvalResult.nextPlan,
              state,
              mergedEmittedIds,
              approvalResult.isApproved,
            );
          }
          continue;
        } catch (error) {
          const recovery = yield* this.#handleRecovery(error, state);
          if (recovery.kind === 'terminated') {
            throw error;
          }
          if (recovery.kind === 'stale') {
            return { kind: 'stale' };
          }
          if (recovery.kind === 'fresh_start') {
            return {
              kind: 'fresh_start_required',
              retryCounts: recovery.retryCounts,
              ...(recovery.delayMs !== undefined ? { delayMs: recovery.delayMs } : {}),
              ...(recovery.useStandardServiceTier ? { useStandardServiceTier: true } : {}),
            };
          }
          // recovery.kind === 'resume' -> continue loop
        }
      }
    } catch (error) {
      this.deps.logger.error('Conversation stream error during continuation', {
        eventType: 'stream.failed',
        category: 'stream',
        phase: 'abort',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
        errorMessage: describeError(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      yield {
        type: 'error' as const,
        message: describeError(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      };
      throw error;
    } finally {
      prepared.removeInterceptor();
    }
  }

  async *#handleRecovery(
    error: unknown,
    state: ContinuationState,
  ): AsyncGenerator<ConversationEvent, import('./continuation-recovery-handler.js').ContinuationRecoveryResult, void> {
    const recoveryIterator = this.deps.recoveryHandler.handle({ error, state });
    let recoveryNext = await recoveryIterator.next();
    while (!recoveryNext.done) {
      yield recoveryNext.value;
      recoveryNext = await recoveryIterator.next();
    }
    return recoveryNext.value;
  }

  #buildResponse(
    result: Extract<ConversationTerminal, { type: 'response' }>,
    usage?: NormalizedUsage,
  ): ConversationTerminal {
    return {
      type: 'response',
      commandMessages: result.commandMessages ?? [],
      finalText: result.finalText,
      ...(result.reasoningText ? { reasoningText: result.reasoningText } : {}),
      ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
      turnItems: result.turnItems,
    };
  }

  async #handleApprovalOutcome(
    outcome: any,
    state: ContinuationState,
    activePolicy: ApprovalDecisionPolicy,
    nextCumulativeUsage?: NormalizedUsage,
    previousInputForSurge?: unknown,
  ): Promise<
    | { action: 'return'; result: ContinuationDriveResult }
    | { action: 'loop'; nextPlan: any; isApproved: boolean }
    | { action: 'continue' }
  > {
    const { kind } = outcome;

    if (kind === 'auto_approve') {
      this.deps.logger.debug('Shell command auto-approved by LLM', {
        eventType: 'approval.auto_approved',
        category: 'approval',
        phase: 'approval',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
        callId: outcome.callId,
        command: outcome.argumentsText,
        model: outcome.advisory.model,
        reasoning: outcome.advisory.reasoning,
      });

      const nextPlan = this.deps.approvalFlow.prepareContinuation('y', undefined);
      if (!nextPlan) {
        const approvalFallback = this.#buildApprovalRequiredFromAutoApprove(outcome, nextCumulativeUsage);
        return { action: 'return', result: { kind: 'approval_required', result: approvalFallback } };
      }

      return { action: 'loop', nextPlan, isApproved: true };
    }

    const approvalContext = {
      toolName: outcome.result.approval.toolName,
      argumentsText: outcome.result.approval.argumentsText,
      callId: outcome.result.approval.callId,
      llmAdvisory: outcome.result.approval.llmAdvisory,
    };

    const decision = await activePolicy.decide(approvalContext);

    if (decision === 'prompt') {
      this.deps.planApplier.recordPendingApproval(approvalContext);
      if (outcome.result.approval.callId) {
        this.deps.logger.debug('Tool approval required', {
          eventType: 'approval.required',
          category: 'approval',
          phase: 'approval',
          sessionId: this.deps.sessionId,
          traceId: this.deps.logger.getCorrelationId(),
          toolName: outcome.result.approval.toolName,
        });
      }
      this.#recordSuccess(state, previousInputForSurge);
      const resultWithUsage: ConversationTerminal = {
        ...outcome.result,
        ...(nextCumulativeUsage && Object.keys(nextCumulativeUsage).length > 0 ? { usage: nextCumulativeUsage } : {}),
      };
      return { action: 'return', result: { kind: 'approval_required', result: resultWithUsage } };
    }

    if (decision === 'approve') {
      this.deps.logger.debug('Shell command auto-approved by policy', {
        eventType: 'approval.auto_approved',
        category: 'approval',
        phase: 'approval',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
        callId: approvalContext.callId,
        command: approvalContext.argumentsText,
      });
    }

    const answer = decision === 'approve' ? 'y' : 'n';
    const nextPlan = this.deps.approvalFlow.prepareContinuation(answer, undefined);
    if (!nextPlan) {
      return { action: 'return', result: { kind: 'approval_required', result: outcome.result } };
    }

    return { action: 'loop', nextPlan, isApproved: answer === 'y' };
  }

  #recordSuccess(state: ContinuationState, previousInputForSurge?: unknown): void {
    this.deps.inputPlanner.recordSuccess(
      state.inputMode === 'delta' ? (state.lastStream as any) : this.deps.conversationStore.getHistory(),
      state.inputMode === 'delta'
        ? { kind: state.inputMode }
        : { kind: state.inputMode, previousInput: previousInputForSurge },
    );
  }

  #buildApprovalRequiredFromAutoApprove(
    outcome: { kind: 'auto_approve'; advisory: LLMAdvisory; callId: string | undefined; argumentsText: string },
    usage?: NormalizedUsage,
  ): ConversationTerminal {
    const pending = this.deps.approvalFlow.getPending();
    if (pending) {
      const { toolName, argumentsText } = getToolInfoFromInterruption(pending.interruption);
      const agent =
        pending.interruption && typeof pending.interruption === 'object'
          ? (pending.interruption as Record<string, unknown>).agent
          : undefined;
      const agentName = agent && typeof agent === 'object' ? (agent as Record<string, unknown>).name : 'Agent';
      const callId = getCallIdFromObject(pending.interruption);

      return {
        type: 'approval_required',
        approval: {
          agentName: typeof agentName === 'string' ? agentName : 'Agent',
          toolName: toolName ?? 'Unknown Tool',
          argumentsText,
          rawInterruption: pending.interruption,
          ...(callId ? { callId: String(callId) } : {}),
          llmAdvisory: outcome.advisory,
        },
        usage,
      };
    }

    return {
      type: 'approval_required',
      approval: {
        agentName: 'Agent',
        toolName: 'Unknown Tool',
        argumentsText: outcome.argumentsText,
        rawInterruption: undefined,
        ...(outcome.callId ? { callId: outcome.callId } : {}),
        llmAdvisory: outcome.advisory,
      },
      usage,
    };
  }
}
