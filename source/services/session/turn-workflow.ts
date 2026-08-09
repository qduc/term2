import type { ContinuationHandle } from '../../contracts/continuation-handle.js';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type { SteerOutcome } from '../agent-runtime/application-run-loop.js';
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
import { selectAgentStreamItems, type AgentStream } from '../agent-stream.js';
import {
  extractCommandMessages,
  markToolCallAsLlmAutoApproved,
} from '../../utils/streaming/extract-command-messages.js';
import {
  collectKnownToolCallIds,
  resolveAbortedApprovalCallIds,
  resolveResponseCycleCallIds,
} from './continuation-call-id-resolver.js';
import { LiveRun } from './live-run.js';
import type { PostExecutePendingRegistry, PostExecutePendingEntry } from './post-execute-pending-registry.js';
import type { SessionAccessState } from './session-access-state.js';
import { extractFinalizationSnapshot } from '../stream-snapshot.js';
import { lastOpenAICompaction } from './session-stream-processor.js';
import { contextCompactionFailureCategory } from '../../providers/openai-responses-model.js';
import type { OpenAIRootFreshTurnSelectorParityObserver } from '../openai-root-selector-parity-observer.js';
import type { HookLifecyclePort } from '../hooks/hook-service.js';
import type { HookEventFactory } from '../hooks/hook-event-factory.js';

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
  /** Omitted for caller-owned, nested, and transient clients. */
  openAIRootFreshTurnSelectorParityObserver?: OpenAIRootFreshTurnSelectorParityObserver;
  /** Handle-owned root capability; omitted only by nested compatibility callers. */
  sessionAccess?: SessionAccessState;
  batchCoordinator?: ToolApprovalBatchCoordinator;
  postExecutePending: PostExecutePendingRegistry;
  setActivePostExecuteRunId?: (runId: string | null) => void;
  hookLifecycle?: HookLifecyclePort;
  hookEvents?: HookEventFactory;
}

export class TurnWorkflow {
  readonly #batchCoordinator: ToolApprovalBatchCoordinator;
  readonly #liveAttemptOwners = new WeakSet<TurnAttempt>();
  #liveRun: LiveRun<ConversationEvent, { kind: 'completed'; outcome: any } | { kind: 'stale' }> | null = null;
  #nextLiveRunId = 0;
  #hookTurnId: string | undefined;

  constructor(private readonly deps: TurnWorkflowDeps) {
    this.#batchCoordinator =
      deps.batchCoordinator ??
      new ToolApprovalBatchCoordinator({
        approvalFlow: deps.approvalFlow,
        planApplier: deps.planApplier,
        shellAutoApproval: deps.shellAutoApproval,
        logger: deps.logger,
        sessionId: deps.sessionId,
        sessionAccess: deps.sessionAccess,
        isCurrent: (token) => deps.generationGuard.isCurrent(token),
        hookLifecycle: deps.hookLifecycle,
        hookEvents: deps.hookEvents,
      });
  }

  /**
   * Tell the run loop where this turn begins and ends, so a message steered
   * into it survives the gaps between its streams — the preparation before the
   * first request, and the backoff before a retry restarts one.
   */
  openTurn(): void {
    this.deps.agentClient.openTurn?.();
  }

  closeTurn(): void {
    this.deps.agentClient.closeTurn?.();
  }

  steer(items: readonly ProviderInputItem[], options?: { id?: string }): Promise<SteerOutcome> {
    return this.deps.agentClient.steer?.(items, options) ?? Promise.resolve('released');
  }

  /** Drop a still-waiting steer. False when it was already admitted. */
  retractSteer(id: string): boolean {
    return this.deps.agentClient.retractSteer?.(id) ?? false;
  }

  /** Replace a waiting steer's items in place, keeping its position. */
  editSteer(id: string, items: readonly ProviderInputItem[]): boolean {
    return this.deps.agentClient.editSteer?.(id, items) ?? false;
  }

  /** Internal composition seam for correlating physical tool calls to a turn. */
  setHookTurnId(turnId: string | undefined): void {
    this.#hookTurnId = turnId;
  }

  async *executeInitial(
    attemptOrInput: TurnAttempt | string | UserTurn,
    options: InitialTurnRunOptions = {},
  ): AsyncGenerator<ConversationEvent, TurnOutcome, void> {
    try {
      return yield* this.#executeInitialBody(attemptOrInput, options);
    } catch (error) {
      const failure = contextCompactionFailureCategory(error);
      if (failure) {
        yield {
          type: 'context_compaction_failed',
          provider: 'openai',
          sessionId: this.deps.sessionId,
          errorCategory: failure,
          durationMs: 0,
        };
      }
      throw error;
    }
  }

  async *#executeInitialBody(
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
    try {
      return yield* this.#executeContinuationBodyImpl(init, policy);
    } catch (error) {
      const failure = contextCompactionFailureCategory(error);
      if (failure) {
        yield {
          type: 'context_compaction_failed',
          provider: 'openai',
          sessionId: this.deps.sessionId,
          errorCategory: failure,
          durationMs: 0,
        };
      }
      throw error;
    }
  }

  async *#executeContinuationBodyImpl(
    init: ContinuationInit,
    policy?: ApprovalDecisionPolicy,
  ): AsyncGenerator<ConversationEvent, TurnOutcome, void> {
    if (this.#liveRun) {
      return yield* this.#continuePostExecuteRun();
    }
    const driveResult = yield* this.executeContinuationAttempt(init, policy);

    if (driveResult.kind !== 'fresh_start_required') {
      return driveResult as TurnOutcome;
    }

    return yield* this.#replayFromFreshStart(init.generation, driveResult);
  }

  /** Re-observe an already-running post-execute stream without involving SDK approvals. */
  async *continuePostExecute(): AsyncGenerator<ConversationEvent, TurnOutcome, void> {
    return yield* this.#continuePostExecuteRun();
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
            observeOpenAIRootSelectorParity:
              !options.replayFromHistory &&
              !currentResumeState &&
              !currentResumePreviousResponseId &&
              this.#isFirstAttempt(attempt.retryCounts),
          });
          if (cycleResult.kind === 'stale') {
            return { kind: 'stale' };
          }
          if (cycleResult.kind === 'post_execute_approval_required') {
            return { kind: 'approval_required', terminal: this.#postExecuteApprovalTerminal(cycleResult.entries) };
          }
          const { outcome } = cycleResult;

          if (outcome.kind === 'response') {
            return { kind: 'response', terminal: outcome.result };
          }

          if (outcome.kind === 'auto_approve') {
            if (outcome.advisory?.source === 'llm') {
              markToolCallAsLlmAutoApproved(outcome.callId);
            }
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
          await this.#emitApprovalRequested(outcome.result.approval);
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
      // A post-execute gate hands this attempt to its live consumer. That task
      // owns terminal cleanup; closing here would detach abort handling while
      // the SDK is still waiting at the tool boundary.
      if (!this.#liveAttemptOwners.has(attempt)) attempt.close();
    }
  }

  async *#executeInitialStreamCycle(
    attempt: TurnAttempt,
    options: {
      resumeState?: ContinuationHandle;
      resumePreviousResponseId?: string | null;
      observeOpenAIRootSelectorParity: boolean;
    },
  ): AsyncGenerator<
    ConversationEvent,
    | { kind: 'completed'; outcome: any }
    | { kind: 'stale' }
    | { kind: 'post_execute_approval_required'; entries: readonly PostExecutePendingEntry[] },
    void
  > {
    // Establish ownership before asking the client for a stream. Some clients
    // can start consuming synchronously while constructing their stream.
    const runId = `${this.deps.sessionId}:live:${++this.#nextLiveRunId}`;
    this.deps.setActivePostExecuteRunId?.(runId);
    let stream: AgentStream;
    try {
      stream = await this.#startInitialStream(attempt, options);
    } catch (error) {
      this.deps.setActivePostExecuteRunId?.(null);
      throw error;
    }
    attempt.attachStream(stream);

    const liveRun = new LiveRun<ConversationEvent, { kind: 'completed'; outcome: any } | { kind: 'stale' }>(
      runId,
      this.deps.postExecutePending,
      async (emit) => {
        try {
          return await this.#consumeInitialStream(stream, attempt, emit);
        } finally {
          this.#liveAttemptOwners.delete(attempt);
          attempt.close();
        }
      },
    );
    this.#liveAttemptOwners.add(attempt);
    this.#liveRun = liveRun;
    return yield* this.#drainLiveRun(liveRun);
  }

  async *#drainLiveRun(
    liveRun: LiveRun<ConversationEvent, { kind: 'completed'; outcome: any } | { kind: 'stale' }>,
  ): AsyncGenerator<
    ConversationEvent,
    | { kind: 'completed'; outcome: any }
    | { kind: 'stale' }
    | { kind: 'post_execute_approval_required'; entries: readonly PostExecutePendingEntry[] },
    void
  > {
    while (true) {
      let state: Awaited<ReturnType<typeof liveRun.next>>;
      try {
        state = await liveRun.next();
      } catch (error) {
        if (this.#liveRun === liveRun) {
          this.#liveRun = null;
          this.deps.setActivePostExecuteRunId?.(null);
        }
        throw error;
      }
      if (state.kind === 'event') {
        yield state.event;
        continue;
      }
      if (state.kind === 'post_execute_approval_required') return state;
      if (state.kind === 'cancelled') {
        if (this.#liveRun === liveRun) {
          this.#liveRun = null;
          this.deps.setActivePostExecuteRunId?.(null);
        }
        return { kind: 'stale' };
      }
      if (this.#liveRun === liveRun) {
        this.#liveRun = null;
        this.deps.setActivePostExecuteRunId?.(null);
      }
      return state.result;
    }
  }

  async #consumeInitialStream(
    stream: AgentStream,
    attempt: TurnAttempt,
    emit: (event: ConversationEvent) => void,
  ): Promise<{ kind: 'completed'; outcome: any } | { kind: 'stale' }> {
    const processor = this.deps.streamProcessor.process(stream, {
      gen: attempt.token,
      source: 'startStream',
      preserveExistingToolArgs: false,
    });
    let next = await processor.next();
    while (!next.done) {
      emit(next.value);
      next = await processor.next();
    }
    const accumulated = next.value;

    const finalized = this.deps.streamProcessor.finalize(stream, attempt.token, attempt.inputMode!, 'startStream');
    if (finalized.kind === 'stale') {
      return { kind: 'stale' };
    }

    for (const event of this.#contextCompactionCompletedEvent({
      stream,
      inputTokensBefore: accumulated.latestUsage?.prompt_tokens,
      durationMs: accumulated.lastContextCompactionDurationMs,
    })) {
      emit(event);
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
        sessionAccess: this.deps.sessionAccess,
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

  /**
   * The compaction completion notice.
   *
   * `started` is *not* emitted here: it is surfaced live by the stream processor from the
   * provider's own `output_item.added` frame, which is the only moment that corresponds to
   * compaction actually beginning. This site owns only the completion, because the token
   * count it reports comes from `usage`, which the provider does not send until the response
   * completes — after the compaction frames have already gone by.
   *
   * `durationMs` likewise comes from the frames (parked on the accumulator), not from a
   * clock read here: a `Date.now()` captured at this call site is taken after the stream has
   * finished, so it would always yield ~0.
   */
  #contextCompactionCompletedEvent(args: {
    stream: AgentStream;
    inputTokensBefore?: number;
    durationMs?: number;
  }): ConversationEvent[] {
    const compaction = lastOpenAICompaction(extractFinalizationSnapshot(args.stream).output);
    if (!compaction) return [];
    return [
      {
        type: 'context_compaction_completed',
        provider: compaction.provider,
        sessionId: this.deps.sessionId,
        ...(args.inputTokensBefore !== undefined ? { inputTokensBefore: args.inputTokensBefore } : {}),
        // The provider reports no post-compaction size: usage.input_tokens is the
        // compaction pass's own input, i.e. the pre-compaction total.
        inputTokensAfter: undefined,
        durationMs: args.durationMs ?? 0,
      },
    ];
  }

  async *#continuePostExecuteRun(): AsyncGenerator<ConversationEvent, TurnOutcome, void> {
    const liveRun = this.#liveRun;
    if (!liveRun) {
      throw new Error('No live post-execute run active to continue.');
    }
    try {
      const result = yield* this.#drainLiveRun(liveRun);
      if (result.kind === 'stale') return { kind: 'stale' };
      if (result.kind === 'post_execute_approval_required') {
        return { kind: 'approval_required', terminal: this.#postExecuteApprovalTerminal(result.entries) };
      }
      const { outcome } = result;
      if (outcome.kind === 'response') return { kind: 'response', terminal: outcome.result };
      if (outcome.kind === 'approval_required') return { kind: 'approval_required', terminal: outcome.result };
      throw new Error('Post-execute live run finished without a terminal outcome.');
    } catch (error) {
      this.#liveRun = null;
      this.deps.setActivePostExecuteRunId?.(null);
      throw error;
    }
  }

  #postExecuteApprovalTerminal(entries: readonly PostExecutePendingEntry[]): ConversationTerminal {
    const entry = entries[0];
    const snapshot = this.deps.postExecutePending.snapshot();
    return createApprovalRequiredTerminal({
      agentName: 'Agent',
      toolName: entry.toolName,
      argumentsText: entry.argumentsText,
      deniedRead: entry.deniedRead,
      rawInterruption: { type: 'post_execute', runId: entry.runId, id: entry.id },
      callId: entry.toolCallId,
      postExecute: {
        kind: 'post_execute',
        sessionId: snapshot.sessionId,
        epoch: snapshot.epoch,
        revision: snapshot.revision,
        ids: [entry.id],
      },
    });
  }

  async #startInitialStream(
    attempt: TurnAttempt,
    options: {
      resumeState?: ContinuationHandle;
      resumePreviousResponseId?: string | null;
      observeOpenAIRootSelectorParity: boolean;
    },
  ): Promise<AgentStream> {
    if (options.resumeState && typeof this.deps.agentClient.continueRunStream === 'function') {
      const resumeOptions: any = {
        previousResponseId: options.resumePreviousResponseId ?? this.deps.providerContinuity.previousResponseId,
        sessionId: this.deps.sessionId,
        providerHistorySnapshot: this.deps.conversationStore.getProviderHistorySnapshot(),
        hookTurnId: this.#hookTurnId,
      };
      Object.defineProperty(resumeOptions, 'providerContinuityLineage', {
        value: this.deps.providerContinuity.lineage,
        enumerable: this.deps.providerContinuity.lineage !== 0,
      });
      return (await this.deps.agentClient.continueRunStream(options.resumeState, resumeOptions)) as AgentStream;
    }

    const legacyPreviousResponseId =
      attempt.inputMode === 'delta' ? this.deps.providerContinuity.previousResponseId : null;
    let selectedPreviousResponseId = legacyPreviousResponseId;
    if (
      options.observeOpenAIRootSelectorParity &&
      this.deps.agentClient.getProvider?.() === 'openai' &&
      legacyPreviousResponseId &&
      attempt.providerHistorySnapshot
    ) {
      try {
        const observation = this.deps.openAIRootFreshTurnSelectorParityObserver?.observe({
          legacyPreviousResponseId,
          plannedSnapshot: attempt.providerHistorySnapshot,
        });
        // This is intentionally an equality-gated ownership handoff: a
        // checkpoint can only become the selector when it has proved the same
        // ID the established legacy selector would send for this exact
        // snapshot. Any absent, ineligible, mismatched, or faulty observation
        // retains legacy selection.
        if (
          observation?.eligible &&
          observation.matches &&
          observation.acceptedCheckpointResponseId === legacyPreviousResponseId
        ) {
          selectedPreviousResponseId = observation.acceptedCheckpointResponseId;
        }
      } catch {
        // Parity must never change the established request path on failure.
      }
    }
    const startOptions: any = {
      previousResponseId: selectedPreviousResponseId,
      sessionId: this.deps.sessionId,
      providerHistorySnapshot: attempt.providerHistorySnapshot,
      hookTurnId: this.#hookTurnId,
    };
    Object.defineProperty(startOptions, 'providerContinuityLineage', {
      value: this.deps.providerContinuity.lineage,
      enumerable: this.deps.providerContinuity.lineage !== 0,
    });
    return (await this.deps.agentClient.startStream(attempt.streamInput!, startOptions)) as AgentStream;
  }

  #isFirstAttempt(retryCounts: RetryCounts): boolean {
    return (
      retryCounts.transientRetryCount === 0 &&
      retryCounts.serviceTierFallbackCount === 0 &&
      retryCounts.modelRetryCount === 0 &&
      retryCounts.transportDowngradeCount === 0
    );
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

          const cycleResult = yield* this.#executeContinuationStreamCycle(
            state,
            init.kind === 'approval_decision' && init.stopAfterApprovalResolution === true,
          );

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
              interruptionCallIds: this.#interruptionCallIds(
                approvalResult.nextPlan.pendingApprovalContext.state,
                approvalResult.nextPlan.pendingApprovalContext.interruption,
              ),
              completedResultCallIds: this.deps.toolTracker.completedResultCallIdsForCurrentTurn(),
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
        interruptionCallIds: this.#interruptionCallIds(state.currentState, pending?.interruption),
        completedResultCallIds: this.deps.toolTracker.completedResultCallIdsForCurrentTurn(),
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
      // Cost records are run-cumulative, so the continuation cycle must carry
      // forward what the collector observed; dropping them here silently
      // unprices every turn that used a tool or paused for approval.
      ...(result.costRecords?.length ? { costRecords: result.costRecords } : {}),
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
      if (outcome.advisory?.source === 'llm') {
        markToolCallAsLlmAutoApproved(outcome.callId);
      }
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

      const nextPlan = this.deps.approvalFlow.prepareContinuation('y', undefined, 'policy');
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
    const nextPlan = this.deps.approvalFlow.prepareContinuation(
      answer,
      undefined,
      decision === 'approve' || decision === 'reject' ? 'policy' : 'user',
    );
    if (!nextPlan) {
      return { action: 'return', result: { kind: 'approval_required', terminal: outcome.result } };
    }

    return { action: 'loop', nextPlan, isApproved: answer === 'y' };
  }

  async *#executeContinuationStreamCycle(
    state: ContinuationState,
    stopAfterApprovalResolution = false,
  ): AsyncGenerator<
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
    const continuationOptions: any = {
      previousResponseId: state.currentResumePreviousResponseId ?? this.deps.providerContinuity.previousResponseId,
      sessionId: this.deps.sessionId,
      toolResultCallIds: state.currentCallIds,
      knownToolCallIds: collectKnownToolCallIds(
        this.deps.conversationStore.getHistory(),
        this.deps.toolTracker.activeCallIdsForCurrentTurn(),
      ),
      providerHistorySnapshot: this.deps.conversationStore.getProviderHistorySnapshot(),
      hookTurnId: this.#hookTurnId,
      ...(stopAfterApprovalResolution ? { stopAfterApprovalResolution: true } : {}),
    };
    Object.defineProperty(continuationOptions, 'providerContinuityLineage', {
      value: this.deps.providerContinuity.lineage,
      enumerable: this.deps.providerContinuity.lineage !== 0,
    });
    const stream = (await this.deps.agentClient.continueRunStream(
      state.currentState,
      continuationOptions,
    )) as AgentStream;
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

    for (const event of this.#contextCompactionCompletedEvent({
      stream,
      inputTokensBefore: acc.latestUsage?.prompt_tokens,
      durationMs: acc.lastContextCompactionDurationMs,
    })) {
      yield event;
    }

    const mergedEmittedIds = new Set([...allEmittedIds, ...acc.emittedCommandIds]);

    const streamMessages = extractCommandMessages(selectAgentStreamItems(stream));
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
        sessionAccess: this.deps.sessionAccess,
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
        interruptionCallIds: this.#interruptionCallIds(init.abortedContext.state, init.abortedContext.interruption),
        completedResultCallIds: this.deps.toolTracker.completedResultCallIdsForCurrentTurn(),
      });
    }
    return resolveResponseCycleCallIds({
      interruptionCallIds: this.#interruptionCallIds(prepared.state, prepared.interruption),
      completedResultCallIds: this.deps.toolTracker.completedResultCallIdsForCurrentTurn(),
      fallbackCallIds: this.deps.toolTracker.activeCallIdsForCurrentTurn(),
      conversationHistory: this.deps.conversationStore.getHistory(),
    });
  }

  #interruptionCallIds(state: unknown, primaryInterruption: unknown): string[] {
    const callIds = new Set<string>();
    const interruptions = getMethod<[], unknown>(state, 'getInterruptions')?.();
    if (Array.isArray(interruptions)) {
      for (const interruption of interruptions) {
        const callId = getCallIdFromObject(interruption);
        if (callId) {
          callIds.add(callId);
        }
      }
    }

    const primaryCallId = getCallIdFromObject(primaryInterruption);
    if (primaryCallId) {
      callIds.add(primaryCallId);
    }
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

  abortLiveRun(): void {
    const liveRun = this.#liveRun;
    this.#liveRun = null;
    liveRun?.cancel();
    this.deps.setActivePostExecuteRunId?.(null);
  }

  get activePostExecuteRunId(): string | null {
    return this.#liveRun?.runId ?? null;
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

  async #emitApprovalRequested(approval: { toolName: string; argumentsText: string; callId?: string }): Promise<void> {
    if (!this.deps.hookLifecycle || !this.deps.hookEvents) return;
    let normalizedArguments: unknown = approval.argumentsText;
    try {
      normalizedArguments = JSON.parse(approval.argumentsText);
    } catch {
      // Preserve a bounded opaque representation for malformed model input.
    }
    await this.deps.hookLifecycle.emit(
      this.deps.hookEvents.create(
        'approval.requested',
        {
          toolName: approval.toolName,
          normalizedArguments: this.deps.hookEvents.includeToolArguments
            ? normalizedArguments
            : typeof normalizedArguments === 'string'
            ? normalizedArguments.slice(0, 500)
            : JSON.stringify(normalizedArguments).slice(0, 500),
          approvalKind: approval.toolName === 'ask_user' ? 'ask_user' : 'tool',
          proposedDecision: 'approve',
        },
        { toolCallId: approval.callId },
      ),
    );
  }
}
