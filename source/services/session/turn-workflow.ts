import type { RunState } from '@openai/agents';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { ShellAutoApprovalResolver } from '../approval/shell-auto-approval-resolver.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { TurnItemAccumulator } from './turn-item-accumulator.js';
import type { GenerationGuard } from '../generation-guard.js';
import { TurnAttempt } from './turn-attempt.js';
import { getMethod, getCallIdFromObject, getToolInfoFromInterruption } from '../interruption-info.js';
import type { UserTurn } from '../../types/user-turn.js';
import type { InitialTurnRunOptions, TurnAttemptFactory } from './turn-attempt-factory.js';
import type { InitialInputPreparer } from './initial-input-preparer.js';
import type { InitialTurnRecoveryHandler } from './initial-turn-recovery-handler.js';
import { AssistantTurnJournal } from '../logging/assistant-turn-journal.js';
import type { TurnOutcome } from './turn-status-machine.js';
import type { ConversationTerminal, LLMAdvisory } from '../../contracts/conversation.js';
import type { RetryCounts } from '../retry/retry-contracts.js';

export type InternalTurnOutcome =
  | { kind: 'response'; terminal: ConversationTerminal }
  | { kind: 'approval_required'; terminal: ConversationTerminal }
  | { kind: 'stale' }
  | { kind: 'failed' }
  | { kind: 'fresh_start_required'; retryCounts: RetryCounts; delayMs?: number; useStandardServiceTier?: boolean }
  | {
      kind: 'abort_resolution_required';
      abortedContext: AbortedApprovalContext;
      userText: string;
      generation: number;
    }
  | {
      kind: 'auto_approval_required';
      generation: number;
      callId?: string;
      command?: string;
    };
import type { AbortedApprovalContext } from '../approval/approval-state.js';
import type { ApprovalDecisionPolicy } from '../approval/approval-decision-policy.js';
import { ShellAutoApprovalDecisionPolicy } from '../approval/approval-decision-policy.js';
import type { ConversationStore } from '../conversation/conversation-store.js';
import type { SessionInputPlanner } from './session-input-planner.js';
import type { ApprovalFlowCoordinator } from '../approval/approval-flow-coordinator.js';
import { describeError } from '../../utils/error-helpers.js';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { ContinuationPlanApplier } from './continuation-plan-applier.js';
import type { ContinuationRecoveryHandler } from './continuation-recovery-handler.js';
import { ContinuationState, type ContinuationInit, type PreparedContinuation } from './continuation-state.js';
import { ToolApprovalBatchCoordinator } from '../approval/tool-approval-batch-coordinator.js';
import {
  createApprovalRequiredTerminal,
  buildConversationResult,
} from '../conversation/conversation-result-builder.js';
import type { ProviderContinuity } from '../provider-continuity.js';
import type { SessionStreamProcessor } from './session-stream-processor.js';
import type { AgentStream } from '../agent-stream.js';
import { extractCommandMessages } from '../../utils/streaming/extract-command-messages.js';
import { resolveAbortedApprovalCallIds, resolveResponseCycleCallIds } from './continuation-call-id-resolver.js';

export interface TurnWorkflowDeps {
  agentClient: ConversationAgentClient;
  logger: ILoggingService;
  sessionId: string;
  turnAccumulator: TurnItemAccumulator;
  toolTracker: SessionToolTracker;
  shellAutoApproval: ShellAutoApprovalResolver;
  generationGuard: GenerationGuard;
  attemptFactory: TurnAttemptFactory;
  inputPreparer: InitialInputPreparer;
  streamProcessor: SessionStreamProcessor;
  recoveryHandler: InitialTurnRecoveryHandler;
  journal: AssistantTurnJournal;

  inputPlanner: SessionInputPlanner;
  conversationStore: ConversationStore;
  approvalFlow: ApprovalFlowCoordinator;
  planApplier: ContinuationPlanApplier;
  continuationRecoveryHandler: ContinuationRecoveryHandler;
  providerContinuity: ProviderContinuity;
  batchCoordinator?: ToolApprovalBatchCoordinator;
}

export class TurnWorkflow {
  readonly #batchCoordinator: ToolApprovalBatchCoordinator;

  constructor(private readonly deps: TurnWorkflowDeps) {
    this.#batchCoordinator =
      deps.batchCoordinator ??
      new ToolApprovalBatchCoordinator({
        approvalFlow: deps.approvalFlow,
        planApplier: deps.planApplier,
        shellAutoApproval: deps.shellAutoApproval,
        logger: deps.logger,
        sessionId: deps.sessionId,
        isCurrent: (token) => deps.generationGuard.isCurrent(token),
      });
  }

  async *executeInitial(
    attemptOrInput: TurnAttempt | string | UserTurn,
    options: InitialTurnRunOptions = {},
  ): AsyncGenerator<ConversationEvent, TurnOutcome, void> {
    let currentInput: TurnAttempt | string | UserTurn = attemptOrInput;
    let currentOptions = options;

    while (true) {
      const initialOutcome = yield* this.executeInitialAttempt(currentInput, currentOptions);

      if (initialOutcome.kind !== 'abort_resolution_required' && initialOutcome.kind !== 'auto_approval_required') {
        return initialOutcome as TurnOutcome;
      }

      const generation = initialOutcome.generation;
      let driveResult: InternalTurnOutcome;
      if (initialOutcome.kind === 'abort_resolution_required') {
        driveResult = yield* this.executeContinuationAttempt(
          {
            kind: 'abort_resolution',
            abortedContext: initialOutcome.abortedContext,
            userText: initialOutcome.userText,
            generation,
          },
          new ShellAutoApprovalDecisionPolicy(this.deps.shellAutoApproval),
        );
      } else {
        driveResult = yield* this.executeContinuationAttempt(
          {
            kind: 'approval_decision',
            answer: 'y',
            generation,
          },
          new ShellAutoApprovalDecisionPolicy(this.deps.shellAutoApproval),
        );
      }

      if (driveResult.kind !== 'fresh_start_required') {
        return driveResult as TurnOutcome;
      }

      currentInput = { text: '' };
      currentOptions = {
        skipUserMessage: true,
        retries: driveResult.retryCounts,
        delayMs: driveResult.delayMs,
        useStandardServiceTier: driveResult.useStandardServiceTier,
        token: generation,
        replayFromHistory: true,
      };
    }
  }

  async *executeContinuation(
    init: ContinuationInit,
    policy?: ApprovalDecisionPolicy,
  ): AsyncGenerator<ConversationEvent, TurnOutcome, void> {
    const driveResult = yield* this.executeContinuationAttempt(init, policy);

    if (driveResult.kind !== 'fresh_start_required') {
      return driveResult as TurnOutcome;
    }

    return yield* this.#replayFromFreshStart(init.generation, driveResult);
  }

  #freshStartReplayOptions(
    generation: number,
    result: Extract<InternalTurnOutcome, { kind: 'fresh_start_required' }>,
  ): InitialTurnRunOptions {
    return {
      skipUserMessage: true,
      retries: result.retryCounts,
      delayMs: result.delayMs,
      useStandardServiceTier: result.useStandardServiceTier,
      token: generation,
      replayFromHistory: true,
    };
  }

  async *#replayFromFreshStart(
    generation: number,
    result: Extract<InternalTurnOutcome, { kind: 'fresh_start_required' }>,
  ): AsyncGenerator<ConversationEvent, TurnOutcome, void> {
    return yield* this.executeInitial({ text: '' }, this.#freshStartReplayOptions(generation, result));
  }

  async *executeInitialAttempt(
    attemptOrInput: TurnAttempt | string | UserTurn,
    options: InitialTurnRunOptions = {},
  ): AsyncGenerator<ConversationEvent, InternalTurnOutcome, void> {
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
      options.replayFromHistory ||
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
      this.deps.journal.resetForNewTurn();

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
          // Preserve the follow-up prompt as a normal user turn so the next
          // turn can steer the conversation naturally after an ESC abort.
          const preparation = this.deps.inputPreparer.prepare(attempt, skipUser, {
            bypassInputSurgeGuard: true,
            replayFromHistory: options.replayFromHistory,
          });
          if (preparation.kind === 'blocked') {
            yield preparation.event;
            return { kind: 'failed' };
          }
          this.deps.logger.debug('Resolving aborted approval with fake execution', {
            message: attempt.turn.text,
          });

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
          const cycleResult = yield* this.#executeInitialStreamCycle(attempt, {
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

  async *#executeInitialStreamCycle(
    attempt: TurnAttempt,
    options: { resumeState?: RunState<any, any>; resumePreviousResponseId?: string | null },
  ): AsyncGenerator<ConversationEvent, { kind: 'completed'; outcome: any } | { kind: 'stale' }, void> {
    const stream = await this.#startInitialStream(attempt, options);
    attempt.attachStream(stream);

    const accumulated = yield* this.deps.streamProcessor.process(stream, {
      gen: attempt.token,
      source: 'startStream',
      preserveExistingToolArgs: false,
    });

    const finalized = this.deps.streamProcessor.finalize(stream, attempt.token, attempt.inputMode!, 'startStream');
    if (finalized.kind === 'stale') {
      return { kind: 'stale' };
    }

    const outcome = await buildConversationResult(
      {
        result: stream,
        finalOutputOverride: accumulated.finalOutput || undefined,
        reasoningOutputOverride: accumulated.reasoningOutput || undefined,
        emittedCommandIds: accumulated.emittedCommandIds,
        usage: accumulated.latestUsage,
        toolCallArgumentsById: this.deps.toolTracker.argumentsById,
        turnItems: this.deps.turnAccumulator.getTurnItems(),
        token: attempt.token,
        inputMode: attempt.inputMode!,
      },
      {
        approvalFlow: this.deps.approvalFlow,
        shellAutoApproval: this.deps.shellAutoApproval,
        logger: this.deps.logger,
        sessionId: this.deps.sessionId,
      },
    );

    this.deps.inputPlanner.recordSuccess(
      attempt.inputMode === 'delta' ? attempt.streamInput! : this.deps.conversationStore.getHistory(),
      attempt.inputMode === 'delta'
        ? { kind: attempt.inputMode }
        : { kind: attempt.inputMode!, previousInput: attempt.streamInput! },
    );

    return { kind: 'completed', outcome };
  }

  async #startInitialStream(
    attempt: TurnAttempt,
    options: { resumeState?: RunState<any, any>; resumePreviousResponseId?: string | null },
  ): Promise<AgentStream> {
    if (options.resumeState && typeof this.deps.agentClient.continueRunStream === 'function') {
      return (await this.deps.agentClient.continueRunStream(options.resumeState, {
        previousResponseId: options.resumePreviousResponseId ?? this.deps.providerContinuity.previousResponseId,
        sessionId: this.deps.sessionId,
      })) as AgentStream;
    }

    return (await this.deps.agentClient.startStream(attempt.streamInput!, {
      previousResponseId: attempt.inputMode === 'delta' ? this.deps.providerContinuity.previousResponseId : null,
      sessionId: this.deps.sessionId,
    })) as AgentStream;
  }

  async *executeContinuationAttempt(
    init: ContinuationInit,
    policy?: ApprovalDecisionPolicy,
  ): AsyncGenerator<ConversationEvent, InternalTurnOutcome, void> {
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
          if (batchDecision.kind === 'stale') {
            return { kind: 'stale' };
          }
          if (batchDecision.kind === 'approval_required') {
            return { kind: 'approval_required', terminal: batchDecision.terminal };
          }

          const previousInputForSurge =
            state.inputMode === 'full_history' ? this.deps.conversationStore.getHistory() : undefined;

          const cycleResult = yield* this.#executeContinuationStreamCycle(state);

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
            state.currentCallIds = resolveResponseCycleCallIds({
              runState: approvalResult.nextPlan.pendingApprovalContext.state,
              primaryInterruption: approvalResult.nextPlan.pendingApprovalContext.interruption,
              fallbackCallIds: state.currentCallIds,
              conversationHistory: this.deps.conversationStore.getHistory(),
            });
          }
          continue;
        } catch (error) {
          const recovery = yield* this.#handleContinuationRecovery(error, state);
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
    { kind: 'ready' } | { kind: 'approval_required'; terminal: ConversationTerminal } | { kind: 'stale' },
    void
  > {
    const result = yield* this.#batchCoordinator.stageBatch({
      state,
      policy: activePolicy,
      token: state.token,
    });
    if (result.kind === 'stale') {
      return { kind: 'stale' };
    }
    if (result.kind === 'ready') {
      const pending = this.deps.approvalFlow.getPending?.();
      state.currentCallIds = resolveResponseCycleCallIds({
        runState: state.currentState,
        primaryInterruption: pending?.interruption,
        fallbackCallIds: state.currentCallIds,
        conversationHistory: this.deps.conversationStore.getHistory(),
        preserveFallback: true,
      });
    }
    return result;
  }

  async *#handleContinuationRecovery(
    error: unknown,
    state: ContinuationState,
  ): AsyncGenerator<ConversationEvent, import('./continuation-recovery-handler.js').ContinuationRecoveryResult, void> {
    const recoveryIterator = this.deps.continuationRecoveryHandler.handle({ error, state });
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
    | { action: 'return'; result: TurnOutcome }
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
        model: outcome.advisory?.model,
        reasoning: outcome.advisory?.reasoning,
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

  async *#executeContinuationStreamCycle(state: ContinuationState): AsyncGenerator<
    ConversationEvent,
    | { kind: 'stale' }
    | {
        kind: 'completed';
        outcome: any;
        nextCumulativeMessages: any[];
        nextCumulativeUsage?: NormalizedUsage;
        nextCumulativeTurnItems: any[];
        mergedEmittedIds: Set<string>;
      },
    void
  > {
    const stream = (await this.deps.agentClient.continueRunStream(state.currentState, {
      previousResponseId: state.currentResumePreviousResponseId ?? this.deps.providerContinuity.previousResponseId,
      sessionId: this.deps.sessionId,
      toolResultCallIds: state.currentCallIds,
    })) as AgentStream;
    state.setLastStream(stream);

    const allEmittedIds = new Set([...state.previouslyEmittedIds]);

    const acc = yield* this.deps.streamProcessor.process(stream, {
      gen: state.token,
      source: state.source,
      preserveExistingToolArgs: true,
      previouslyEmittedCommandIds: allEmittedIds,
    });

    const finalizeResult = this.deps.streamProcessor.finalize(stream, state.token, state.inputMode, state.source);
    if (finalizeResult.kind === 'stale') {
      return { kind: 'stale' };
    }

    const mergedEmittedIds = new Set([...allEmittedIds, ...acc.emittedCommandIds]);

    const streamMessages = extractCommandMessages(stream.newItems || stream.history || []);
    const filteredMessages = streamMessages.filter((msg) => !state.previouslyEmittedIds.has(msg.id));
    const nextCumulativeMessages = [...state.cumulativeCommandMessages, ...filteredMessages];
    const nextCumulativeUsage = acc.latestUsage ?? state.cumulativeUsage;
    const nextCumulativeTurnItems = this.deps.turnAccumulator.getTurnItems();

    const outcome = await buildConversationResult(
      {
        result: stream,
        finalOutputOverride: acc.finalOutput || undefined,
        reasoningOutputOverride: acc.reasoningOutput || undefined,
        emittedCommandIds: mergedEmittedIds,
        usage: acc.latestUsage,
        toolCallArgumentsById: this.deps.toolTracker.argumentsById,
        turnItems: nextCumulativeTurnItems,
        token: state.token,
        inputMode: state.inputMode,
        cumulativeUsage: nextCumulativeUsage,
        cumulativeCommandMessages: nextCumulativeMessages,
        cumulativeTurnItems: nextCumulativeTurnItems,
      },
      {
        approvalFlow: this.deps.approvalFlow,
        shellAutoApproval: this.deps.shellAutoApproval,
        logger: this.deps.logger,
        sessionId: this.deps.sessionId,
      },
    );

    return {
      kind: 'completed',
      outcome,
      nextCumulativeMessages,
      nextCumulativeUsage,
      nextCumulativeTurnItems,
      mergedEmittedIds,
    };
  }

  #activeCallIdsForInit(init: ContinuationInit, prepared: PreparedContinuation): string[] {
    if (init.kind === 'abort_resolution') {
      return resolveAbortedApprovalCallIds({
        runState: init.abortedContext.state,
        primaryInterruption: init.abortedContext.interruption,
      });
    }
    return resolveResponseCycleCallIds({
      runState: prepared.state,
      primaryInterruption: prepared.interruption,
      fallbackCallIds: this.deps.toolTracker.activeCallIdsForCurrentTurn(),
      conversationHistory: this.deps.conversationStore.getHistory(),
    });
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
