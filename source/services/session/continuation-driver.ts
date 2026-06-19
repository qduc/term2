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
import {
  asRecord,
  getCallIdFromObject,
  getMethod,
  getString,
  getToolInfoFromInterruption,
} from '../interruption-info.js';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import { createApprovalRequiredTerminal } from '../conversation/conversation-result-builder.js';
import type { ContinuationPlanApplier } from './continuation-plan-applier.js';
import type { ContinuationStreamCycle } from './continuation-stream-cycle.js';
import type { ContinuationRecoveryHandler } from './continuation-recovery-handler.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import { callIdOf } from '../tool-execution-ledger.js';
import { ContinuationState, type PreparedContinuation } from './continuation-state.js';

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
  | { kind: 'approval_required'; terminal: ConversationTerminal }
  | { kind: 'response'; terminal: ConversationTerminal }
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
  toolTracker: SessionToolTracker;
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
    state.initializeFrom(prepared, this.#activeCallIdsForInit(init, prepared));

    try {
      yield* this.deps.planApplier.applyInitialSetup(prepared, state);

      while (true) {
        if (!this.deps.generationGuard.isCurrent(state.token)) {
          return { kind: 'stale' };
        }

        try {
          const batchDecision = yield* this.#stagePendingParallelApprovals(state, activePolicy);
          if (batchDecision.kind === 'approval_required') {
            return { kind: 'approval_required', terminal: batchDecision.terminal };
          }

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
            return { kind: 'response', terminal: this.#buildResponse(outcome.result, nextCumulativeUsage) };
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
            state.currentCallIds = this.#activeCallIdsForResponseCycle(
              approvalResult.nextPlan.pendingApprovalContext.state,
              approvalResult.nextPlan.pendingApprovalContext.interruption,
              state.currentCallIds,
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

  async *#stagePendingParallelApprovals(
    state: ContinuationState,
    activePolicy: ApprovalDecisionPolicy,
  ): AsyncGenerator<
    ConversationEvent,
    { kind: 'ready' } | { kind: 'approval_required'; terminal: ConversationTerminal },
    void
  > {
    const getInterruptions = getMethod<[], unknown>(state.currentState, 'getInterruptions');
    const siblings = getInterruptions?.();
    if (!Array.isArray(siblings) || siblings.length <= 1) {
      return { kind: 'ready' };
    }

    const runContext = asRecord(asRecord(state.currentState)?._context);
    const isToolApproved = getMethod<[{ toolName: string; callId: string }], boolean | undefined>(
      runContext,
      'isToolApproved',
    );
    if (!isToolApproved) {
      return { kind: 'ready' };
    }

    for (const interruption of siblings) {
      const callId = getCallIdFromObject(interruption);
      const { toolName, argumentsText } = getToolInfoFromInterruption(interruption);
      if (!callId || isToolApproved({ toolName, callId }) !== undefined) {
        continue;
      }

      const llmAdvisory =
        toolName === 'shell' || toolName === 'bash'
          ? await this.deps.shellAutoApproval.resolveAdvisoryForInterruption({
              interruption,
              siblings,
            })
          : undefined;
      const approvalContext = { toolName, argumentsText, callId, llmAdvisory };
      const decision = await activePolicy.decide(approvalContext);

      this.deps.approvalFlow.retargetPendingInterruption(interruption);
      if (decision === 'prompt') {
        this.deps.planApplier.recordPendingApproval(approvalContext);
        const interruptionRecord = asRecord(interruption);
        const agent = asRecord(interruptionRecord?.agent);
        return {
          kind: 'approval_required',
          terminal: createApprovalRequiredTerminal({
            agentName: getString(agent, 'name') ?? 'Agent',
            toolName,
            argumentsText,
            rawInterruption: interruption,
            callId,
            llmAdvisory,
            usage: state.cumulativeUsage,
          }),
        };
      }

      const answer = decision === 'approve' ? 'y' : 'n';
      const nextPlan = this.deps.approvalFlow.prepareContinuation(answer, undefined);
      if (!nextPlan) {
        throw new Error('Parallel approval batch lost its pending approval context');
      }
      yield* this.deps.planApplier.applyNextPlan(nextPlan, state, state.previouslyEmittedIds, decision === 'approve');

      state.currentCallIds = this.#activeCallIdsForResponseCycle(
        nextPlan.pendingApprovalContext.state,
        nextPlan.pendingApprovalContext.interruption,
        state.currentCallIds,
        true,
      );
    }

    return { kind: 'ready' };
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
        const approvalFallback = this.#createApprovalRequiredFromAutoApprove(outcome, nextCumulativeUsage);
        return { action: 'return', result: { kind: 'approval_required', terminal: approvalFallback } };
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
      return { action: 'return', result: { kind: 'approval_required', terminal: resultWithUsage } };
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
      return { action: 'return', result: { kind: 'approval_required', terminal: outcome.result } };
    }

    return { action: 'loop', nextPlan, isApproved: answer === 'y' };
  }

  /**
   * Resolves the in-flight call IDs whose tool outputs the upcoming
   * continuation must send to the provider.
   *
   * For an approval decision within the same turn, the tool ledger is
   * authoritative — it tracks every call recorded this turn, regardless of
   * status (including aborted calls, whose synthetic outputs must be sent).
   *
   * For abort resolution, the continuation must replay the entire aborted
   * assistant turn: sibling interruptions come from the run state and completed
   * tool outputs come from the generated-items snapshot. The rejected call's
   * interruption is included as a fallback so the abort record itself still
   * anchors the replay when the state snapshot is sparse.
   */
  #activeCallIdsForInit(init: ContinuationInit, prepared: PreparedContinuation): string[] {
    if (init.kind === 'abort_resolution') {
      return this.#activeCallIdsForAbortedContext(init.abortedContext);
    }
    return this.#activeCallIdsForResponseCycle(
      prepared.state,
      prepared.interruption,
      this.deps.toolTracker.activeCallIdsForCurrentTurn(),
    );
  }

  #activeCallIdsForResponseCycle(
    runState: unknown,
    primaryInterruption: unknown,
    fallbackCallIds: readonly string[],
    preserveFallback = false,
  ): string[] {
    const callIds = new Set<string>();
    const addCallId = (callId: unknown): void => {
      if (typeof callId === 'string' && callId.length > 0) {
        callIds.add(callId);
      }
    };

    if (preserveFallback) {
      for (const callId of fallbackCallIds) {
        addCallId(callId);
      }
    }

    const interruptions = getMethod<[], unknown>(runState, 'getInterruptions')?.();
    if (Array.isArray(interruptions)) {
      for (const interruption of interruptions) {
        addCallId(getCallIdFromObject(interruption));
      }
    }

    addCallId(getCallIdFromObject(primaryInterruption));

    if (callIds.size > 0) {
      return [...callIds];
    }

    return [...fallbackCallIds];
  }

  #activeCallIdsForAbortedContext(abortedContext: AbortedApprovalContext): string[] {
    const callIds = new Set<string>();
    const addCallId = (callId: unknown): void => {
      if (typeof callId === 'string' && callId.length > 0) {
        callIds.add(callId);
      }
    };

    const interruptions = getMethod<[], unknown>(abortedContext.state, 'getInterruptions')?.();
    if (Array.isArray(interruptions)) {
      for (const interruption of interruptions) {
        addCallId(getCallIdFromObject(interruption));
      }
    }

    const generatedItems = asRecord(abortedContext.state)?._generatedItems;
    if (Array.isArray(generatedItems)) {
      for (const item of generatedItems) {
        const raw = asRecord(item)?.rawItem;
        const typeSource = asRecord(raw) ?? asRecord(item);
        const type = typeof typeSource?.type === 'string' ? typeSource.type : '';
        if (
          type === 'function_call_result' ||
          type === 'function_call_output' ||
          type === 'function_call_output_result' ||
          type === 'tool_call_output_item'
        ) {
          addCallId(callIdOf(item));
        }
      }
    }

    addCallId(getCallIdFromObject(abortedContext.interruption));
    return [...callIds];
  }

  #recordSuccess(state: ContinuationState, previousInputForSurge?: unknown): void {
    this.deps.inputPlanner.recordSuccess(
      state.inputMode === 'delta' ? (state.lastStream as any) : this.deps.conversationStore.getHistory(),
      state.inputMode === 'delta'
        ? { kind: state.inputMode }
        : { kind: state.inputMode, previousInput: previousInputForSurge },
    );
  }

  #createApprovalRequiredFromAutoApprove(
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

      return createApprovalRequiredTerminal({
        agentName: typeof agentName === 'string' ? agentName : 'Agent',
        toolName: toolName ?? 'Unknown Tool',
        argumentsText,
        rawInterruption: pending.interruption,
        callId: callId ? String(callId) : undefined,
        llmAdvisory: outcome.advisory,
        usage,
      });
    }

    return createApprovalRequiredTerminal({
      agentName: 'Agent',
      toolName: 'Unknown Tool',
      argumentsText: outcome.argumentsText,
      rawInterruption: undefined,
      callId: outcome.callId,
      llmAdvisory: outcome.advisory,
      usage,
    });
  }
}
