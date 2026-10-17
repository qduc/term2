import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type { SteerOutcome } from '../agent-runtime/application-run-loop.js';
import { isCommittedOutputEvent, type ConversationEvent } from '../conversation/conversation-events.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { SessionToolTracker } from './session-tool-tracker.js';
import type { ShellAutoApprovalResolver } from '../approval/shell-auto-approval-resolver.js';
import type { AgentClientRunOptions, ConversationAgentClient } from '../conversation-agent-client.js';
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
import type { ConversationTerminal } from '../../contracts/conversation.js';

import type { ApprovalDecisionPolicy } from '../approval/approval-decision-policy.js';
import { ShellAutoApprovalDecisionPolicy } from '../approval/approval-decision-policy.js';
import type { ConversationStore } from '../conversation/conversation-store.js';
import type { SessionInputPlanner } from './session-input-planner.js';
import type { ApprovalFlowCoordinator, ContinuationPlan } from '../approval/approval-flow-coordinator.js';
import { isClassifiedCancellation } from '../retry/provider-failure-classification.js';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { ContinuationPlanApplier } from './continuation-plan-applier.js';
import type { ContinuationRecoveryHandler } from './continuation-recovery-handler.js';
import { ContinuationState, type ContinuationInit, type PreparedContinuation } from './continuation-state.js';
import { ToolApprovalBatchCoordinator } from '../approval/tool-approval-batch-coordinator.js';
import {
  createApprovalRequiredTerminal,
  buildConversationResult,
  type BuildResultOutcome,
} from '../conversation/conversation-result-builder.js';
import type { ProviderContinuity } from '../provider-continuity.js';
import type { SessionStreamProcessor } from './session-stream-processor.js';
import { selectAgentStreamItems, type AgentStream } from '../agent-stream.js';
import { extractCommandMessages, ToolCallMarkerStore } from '../../utils/streaming/extract-command-messages.js';
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
import type { HookLifecyclePort } from '../hooks/hook-service.js';
import type { HookEventFactory } from '../hooks/hook-event-factory.js';
import type { RetryRecoveryBudget } from '../retry/retry-recovery-budget.js';
import type { ToolApprovalPolicyRegistry } from '../approval/tool-approval-policy-registry.js';
import type { SessionIdSource } from './session-identity.js';
import { resolvePromptCacheKey, resolveSessionId } from './session-identity.js';

import type { ConversationTurnSession } from '../conversation-agent-client.js';

export interface SessionTurnAdapterDeps {
  agentClient: ConversationAgentClient;
  logger: ILoggingService;
  sessionId: SessionIdSource;
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
  /** Handle-owned root capability; omitted only by nested compatibility callers. */
  sessionAccess?: SessionAccessState;
  approvalPolicyRegistry: ToolApprovalPolicyRegistry;
  batchCoordinator?: ToolApprovalBatchCoordinator;
  postExecutePending: PostExecutePendingRegistry;
  setActivePostExecuteRunId?: (runId: string | null) => void;
  hookLifecycle?: HookLifecyclePort;
  hookEvents?: HookEventFactory;
  toolCallMarkers?: ToolCallMarkerStore;
}

/** Session preparation, projection and decisions. The application runtime owns execution. */
export class SessionTurnAdapter {
  #activePolicyRegistry: ToolApprovalPolicyRegistry;
  readonly #toolCallMarkers: ToolCallMarkerStore;
  readonly #batchCoordinator: ToolApprovalBatchCoordinator;
  #liveRun: LiveRun<ConversationEvent, TurnOutcome> | null = null;
  #nextLiveRunId = 0;
  #hookTurnId: string | undefined;
  #compactionFailureNotified = false;
  #activeRecoveryBudget: RetryRecoveryBudget | undefined;
  #attempt: TurnAttempt | undefined;
  #turnSignal: AbortSignal | undefined;
  #input: TurnAttempt | string | UserTurn = '';
  #options: InitialTurnRunOptions = {};
  #state: ContinuationState | undefined;
  #segmentOutcome: BuildResultOutcome | undefined;
  #outcome: TurnOutcome = { kind: 'failed' };
  #emit: (event: ConversationEvent) => void = () => undefined;
  #pendingDecision:
    | {
        resolve: (decision: { init: ContinuationInit; policy?: ApprovalDecisionPolicy }) => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  #policy: ApprovalDecisionPolicy | undefined;

  #syncPolicyRegistry(): void {
    const current = this.deps.agentClient?.getApprovalPolicyRegistry?.();
    if (current && current !== this.#activePolicyRegistry) {
      this.#activePolicyRegistry = current;
      this.#batchCoordinator.updatePolicyRegistry(current);
    }
  }

  constructor(private readonly deps: SessionTurnAdapterDeps) {
    this.#activePolicyRegistry = deps.approvalPolicyRegistry;
    this.#toolCallMarkers = deps.toolCallMarkers ?? new ToolCallMarkerStore();
    this.#batchCoordinator =
      deps.batchCoordinator ??
      new ToolApprovalBatchCoordinator({
        approvalFlow: deps.approvalFlow,
        planApplier: deps.planApplier,
        shellAutoApproval: deps.shellAutoApproval,
        logger: deps.logger,
        sessionId: deps.sessionId,
        sessionAccess: deps.sessionAccess,
        policyRegistry: deps.approvalPolicyRegistry,
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
    this.#compactionFailureNotified = false;
    this.deps.agentClient.openTurn?.();
  }

  closeTurn(): void {
    this.deps.agentClient.closeTurn?.();
  }

  /**
   * Yields at most one `context_compaction_failed` per failure episode. Returns
   * undefined (and emits nothing) when the same episode already notified, so
   * recovery replays of one request-boundary failure render a single UI message.
   */
  #compactionFailureEvent(category: 'request' | 'validation'): ConversationEvent | undefined {
    if (this.#compactionFailureNotified) return undefined;
    this.#compactionFailureNotified = true;
    return {
      type: 'context_compaction_failed',
      provider: 'openai',
      sessionId: resolveSessionId(this.deps.sessionId),
      errorCategory: category,
      durationMs: 0,
    };
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
    input: TurnAttempt | string | UserTurn,
    options: InitialTurnRunOptions = {},
  ): AsyncGenerator<ConversationEvent, TurnOutcome, void> {
    if (this.#liveRun) throw new Error('A conversation turn is already active');
    this.#syncPolicyRegistry();
    this.#input = input;
    this.#options = options;
    this.#attempt = undefined;
    this.#state = undefined;
    this.#activeRecoveryBudget = undefined;
    this.#outcome = { kind: 'failed' };
    const runId = `${resolveSessionId(this.deps.sessionId)}:live:${++this.#nextLiveRunId}`;
    this.deps.setActivePostExecuteRunId?.(runId);
    this.#liveRun = new LiveRun(runId, this.deps.postExecutePending, async (emit) => {
      this.#emit = emit;
      try {
        await this.deps.agentClient.runTurn({
          prepare: (signal) => this.#prepare(signal),
          consume: (stream) => this.#consume(stream),
          interrupted: () => this.#resolveInteraction(),
          recover: (error) => this.#recover(error),
        });
        return this.#outcome;
      } catch (error) {
        const failure = contextCompactionFailureCategory(error);
        if (failure) {
          const event = this.#compactionFailureEvent(failure);
          if (event) emit(event);
        }
        throw error;
      } finally {
        this.#attempt?.close();
        this.deps.setActivePostExecuteRunId?.(null);
      }
    });
    return yield* this.#observe();
  }

  /** An answer resolves the owned wait; it never starts a continuation run. */
  async *executeContinuation(
    init: ContinuationInit,
    policy?: ApprovalDecisionPolicy,
  ): AsyncGenerator<ConversationEvent, TurnOutcome, void> {
    const pending = this.#pendingDecision;
    if (!pending) throw new Error('No conversation decision is waiting');
    this.#pendingDecision = undefined;
    this.#liveRun?.resume();
    pending.resolve({ init, policy });
    return yield* this.#observe();
  }

  async *continuePostExecute(): AsyncGenerator<ConversationEvent, TurnOutcome, void> {
    return yield* this.#observe();
  }

  async *#observe(): AsyncGenerator<ConversationEvent, TurnOutcome, void> {
    const live = this.#liveRun;
    if (!live) throw new Error('No active conversation turn');
    let waiting = false;
    let completed = false;
    try {
      while (true) {
        const next = await live.next();
        if (next.kind === 'event') {
          yield next.event;
          continue;
        }
        if (next.kind === 'approval_required') {
          waiting = true;
          this.#compactionFailureNotified = false;
          return { kind: 'approval_required', terminal: next.terminal };
        }
        if (next.kind === 'post_execute_approval_required') {
          waiting = true;
          return { kind: 'approval_required', terminal: this.#postExecuteApprovalTerminal(next.entries) };
        }
        if (next.kind === 'cancelled') return { kind: 'stale' };
        this.#compactionFailureNotified = false;
        completed = true;
        return next.result;
      }
    } finally {
      if (!waiting && this.#liveRun === live) {
        if (!completed) await this.abortLiveRun();
        else {
          this.#liveRun = null;
          await live.completion.catch(() => undefined);
        }
      }
    }
  }

  async #project<Result>(events: AsyncGenerator<ConversationEvent, Result, void>): Promise<Result> {
    let next = await events.next();
    while (!next.done) {
      this.#emit(next.value);
      next = await events.next();
    }
    return next.value;
  }

  async #prepare(signal: AbortSignal): ReturnType<ConversationTurnSession['prepare']> {
    this.#turnSignal = signal;
    if (!this.#attempt) {
      const created =
        this.#input instanceof TurnAttempt
          ? { kind: 'created' as const, attempt: this.#input }
          : this.deps.attemptFactory.create(this.#input, {
              ...this.#options,
              signal: this.#options.signal ? AbortSignal.any([signal, this.#options.signal]) : signal,
              recoveryBudget: this.#activeRecoveryBudget ?? this.#options.recoveryBudget,
            });
      if (created.kind === 'stale') {
        this.#outcome = { kind: 'stale' };
        return;
      }
      this.#attempt = created.attempt;
      this.#activeRecoveryBudget = this.#attempt.recoveryBudget;
      const counts = this.#attempt.retryCounts;
      if (
        this.#options.replayFromHistory ||
        !this.#options.skipUserMessage ||
        counts.modelRetryCount > 0 ||
        counts.serviceTierFallbackCount > 0 ||
        counts.transientRetryCount > 0 ||
        counts.transportDowngradeCount > 0
      ) {
        this.deps.turnAccumulator.resetPersistedTurnState();
      }
      this.deps.toolTracker.ledger.beginTurn();
      this.deps.journal.resetForNewTurn();
    }
    const attempt = this.#attempt;
    if (this.#options.delayMs) await this.#waitBeforeRetry(attempt, this.#options.delayMs);
    if (!this.deps.generationGuard.isCurrent(attempt.token)) {
      this.#outcome = { kind: 'stale' };
      return;
    }
    if (this.#options.useStandardServiceTier) this.deps.agentClient.useStandardServiceTierForNextRequest?.();
    const preparation = this.deps.inputPreparer.prepare(attempt, this.#options.skipUserMessage ?? false, this.#options);
    if (preparation.kind === 'blocked') {
      this.#emit(preparation.event);
      this.#outcome = { kind: 'failed' };
      return;
    }
    return {
      input: attempt.streamInput!,
      options: this.#initialOptions(attempt),
    };
  }

  #initialOptions(attempt: TurnAttempt): AgentClientRunOptions {
    const sessionId = resolveSessionId(this.deps.sessionId);
    const promptCacheKey = resolvePromptCacheKey(this.deps.sessionId);
    const options: AgentClientRunOptions = {
      recoveryBudget: attempt.recoveryBudget,
      previousResponseId: this.#options.disableChainingForAttempt
        ? undefined
        : attempt.inputMode === 'delta'
        ? this.deps.providerContinuity.previousResponseId
        : null,
      sessionId,
      ...(promptCacheKey !== sessionId ? { promptCacheKey } : {}),
      providerHistorySnapshot: attempt.providerHistorySnapshot,
      hookTurnId: this.#hookTurnId,
      ...(this.#options.disableChainingForAttempt ? { disableChainingForAttempt: true } : {}),
    };
    Object.defineProperty(options, 'providerContinuityLineage', {
      value: this.deps.providerContinuity.lineage,
      enumerable: this.deps.providerContinuity.lineage !== 0,
    });
    return options;
  }

  async #consume(stream: AgentStream): Promise<void> {
    const attempt = this.#attempt!;
    attempt.attachStream(stream);
    if (!this.#state) {
      const projected = await this.#consumeInitialStream(stream, attempt, this.#emit);
      if (projected.kind === 'stale') {
        this.#outcome = { kind: 'stale' };
        return;
      }
      this.#segmentOutcome = projected.outcome;
      attempt.advanceRetry({ ...attempt.retryCounts, transientRetryCount: 0 });
    } else {
      const projected = await this.#project(this.#projectContinuation(this.#state, stream));
      if (projected.kind === 'stale') {
        this.#outcome = { kind: 'stale' };
        return;
      }
      const state = this.#state;
      state.setRetryCounts({ ...state.retryCounts, transientRetryCount: 0 });
      state.setCumulativeUsage(projected.nextCumulativeUsage);
      state.setCumulativeCommandMessages(projected.nextCumulativeMessages);
      state.setCumulativeTurnItems(projected.nextCumulativeTurnItems);
      this.#segmentOutcome = projected.outcome;
      if (projected.outcome.kind === 'response') this.#recordSuccess(state);
    }
    if (this.#segmentOutcome.kind === 'response')
      this.#outcome = { kind: 'response', terminal: this.#segmentOutcome.result };
  }

  async #waitForApproval(
    terminal: ConversationTerminal,
  ): Promise<{ init: ContinuationInit; policy?: ApprovalDecisionPolicy }> {
    if (this.#pendingDecision) throw new Error('A decision is already waiting');
    const signal = this.#turnSignal!;
    return await new Promise((resolve, reject) => {
      const abort = () => {
        this.#pendingDecision = undefined;
        reject(Object.assign(new Error('Operation aborted'), { name: 'AbortError' }));
      };
      this.#pendingDecision = {
        resolve: (value) => {
          signal?.removeEventListener('abort', abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abort);
          reject(error);
        },
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      this.#liveRun!.pause(terminal);
    });
  }

  async #applyDecision(init: ContinuationInit, policy?: ApprovalDecisionPolicy): Promise<void> {
    const prepared = this.deps.planApplier.prepareInit(init);
    if (!this.#state) {
      this.#state = new ContinuationState(init.generation, this.#activeRecoveryBudget);
      this.#state.initializeFrom(prepared, this.#activeCallIdsForInit(init, prepared));
    } else {
      this.#state.currentState = prepared.state;
      this.#state.source = prepared.source;
      this.#state.inputMode = prepared.inputMode ?? this.#state.inputMode;
      this.#state.previouslyEmittedIds = prepared.previouslyEmittedCommandIds;
      this.#state.currentCallIds = this.#activeCallIdsForInit(init, prepared);
    }
    this.#policy = policy ?? new ShellAutoApprovalDecisionPolicy(this.deps.shellAutoApproval);
    await this.#project(this.deps.planApplier.applyInitialSetup(prepared, this.#state));
  }

  async #resolveInteraction(): Promise<AgentClientRunOptions> {
    const outcome = this.#segmentOutcome;
    if (!outcome || outcome.kind === 'response') throw new Error('Expected an interrupted stream');
    let init: ContinuationInit | undefined;
    if (!this.#state) {
      if (outcome.kind === 'auto_approve') {
        if (outcome.advisory?.source === 'llm') this.#toolCallMarkers.markToolCallAsLlmAutoApproved(outcome.callId);
        init = { kind: 'approval_decision', answer: 'y', generation: this.#attempt!.token };
        await this.#applyDecision(init);
      } else {
        this.deps.planApplier.recordPendingApproval(outcome.result.approval);
        await this.#emitApprovalRequested(outcome.result.approval);
        const answer = await this.#waitForApproval(outcome.result);
        init = answer.init;
        await this.#applyDecision(init, answer.policy);
      }
    } else {
      const result = await this.#handleApprovalOutcome(
        outcome,
        this.#state,
        this.#policy!,
        this.#state.cumulativeUsage,
      );
      if (result.action === 'loop') {
        await this.#project(
          this.deps.planApplier.applyNextPlan(
            result.nextPlan,
            this.#state,
            this.#state.previouslyEmittedIds,
            result.isApproved,
          ),
        );
      } else {
        if (result.result.kind !== 'approval_required')
          throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
        const answer = await this.#waitForApproval(result.result.terminal);
        init = answer.init;
        await this.#applyDecision(init, answer.policy);
      }
    }
    const stopAfterResolution = await this.#resolveBatch(
      init?.kind === 'approval_decision' && init.stopAfterApprovalResolution === true,
    );
    return this.#continuationOptions(stopAfterResolution);
  }

  async #resolveBatch(stopAfterResolution: boolean): Promise<boolean> {
    const result = await this.#project(this.#stagePendingParallelApprovals(this.#state!, this.#policy!));
    if (result.kind === 'stale') throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
    if (result.kind === 'approval_required') {
      const answer = await this.#waitForApproval(result.terminal);
      await this.#applyDecision(answer.init, answer.policy);
      return this.#resolveBatch(
        stopAfterResolution ||
          (answer.init.kind === 'approval_decision' && answer.init.stopAfterApprovalResolution === true),
      );
    }
    return stopAfterResolution;
  }

  #continuationOptions(stopAfterApprovalResolution: boolean): AgentClientRunOptions {
    const state = this.#state!;
    const sessionId = resolveSessionId(this.deps.sessionId);
    const promptCacheKey = resolvePromptCacheKey(this.deps.sessionId);
    const options: AgentClientRunOptions = {
      recoveryBudget: state.recoveryBudget,
      previousResponseId: state.currentResumePreviousResponseId ?? this.deps.providerContinuity.previousResponseId,
      sessionId,
      ...(promptCacheKey !== sessionId ? { promptCacheKey } : {}),
      toolResultCallIds: state.currentCallIds,
      knownToolCallIds: collectKnownToolCallIds(
        this.deps.conversationStore.getHistory(),
        this.deps.toolTracker.activeCallIdsForCurrentTurn(),
      ),
      providerHistorySnapshot: this.deps.conversationStore.getProviderHistorySnapshot(),
      hookTurnId: this.#hookTurnId,
      ...(stopAfterApprovalResolution ? { stopAfterApprovalResolution: true } : {}),
    };
    Object.defineProperty(options, 'providerContinuityLineage', {
      value: this.deps.providerContinuity.lineage,
      enumerable: this.deps.providerContinuity.lineage !== 0,
    });
    return options;
  }

  async #recover(error: unknown): Promise<boolean> {
    if (isClassifiedCancellation(error)) throw error;
    if (!this.#state) {
      const handled = await this.#project(
        this.deps.recoveryHandler.handle({ error, attempt: this.#attempt!, stream: this.#attempt?.stream ?? null }),
      );
      if (handled.kind === 'run') {
        this.#options = {
          ...this.#options,
          ...handled.instruction,
          delayMs: handled.delayMs,
          useStandardServiceTier: handled.useStandardServiceTier,
          disableChainingForAttempt: handled.instruction.disableChainingForAttempt === true,
        };
        return true;
      }
      if (handled.kind === 'stale') {
        this.#outcome = { kind: 'stale' };
        return false;
      }
      throw error;
    }
    const recovered = await this.#project(this.deps.continuationRecoveryHandler.handle({ error, state: this.#state }));
    if (recovered.kind === 'stale') {
      this.#outcome = { kind: 'stale' };
      return false;
    }
    if (recovered.kind === 'terminated') throw error;
    const token = this.#state.token;
    this.#attempt?.close();
    this.#attempt = undefined;
    this.#state = undefined;
    this.#input = { text: '' };
    this.#options = {
      skipUserMessage: true,
      token,
      retries: recovered.retryCounts,
      delayMs: recovered.delayMs,
      useStandardServiceTier: recovered.useStandardServiceTier,
      disableChainingForAttempt: recovered.disableChainingForAttempt,
      replayFromHistory: true,
      recoveryBudget: this.#activeRecoveryBudget,
    };
    this.#syncPolicyRegistry();
    return true;
  }

  abortLiveRun(): Promise<void> {
    const live = this.#liveRun;
    this.#liveRun = null;
    this.#pendingDecision?.reject(Object.assign(new Error('Operation aborted'), { name: 'AbortError' }));
    this.#pendingDecision = undefined;
    live?.cancel();
    this.deps.agentClient.abort();
    return (
      live?.completion.then(
        () => undefined,
        () => undefined,
      ) ?? Promise.resolve()
    );
  }

  get activePostExecuteRunId(): string | null {
    return this.#liveRun?.runId ?? null;
  }

  async #consumeInitialStream(
    stream: AgentStream,
    attempt: TurnAttempt,
    emit: (event: ConversationEvent) => void,
  ): Promise<{ kind: 'completed'; outcome: BuildResultOutcome; generation: number } | { kind: 'stale' }> {
    const processor = this.deps.streamProcessor.process(stream, {
      gen: attempt.token,
      source: 'startStream',
      preserveExistingToolArgs: false,
    });
    let next = await processor.next();
    while (!next.done) {
      if (isCommittedOutputEvent(next.value)) attempt.markModelEventSeen();
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
        sessionId: resolveSessionId(this.deps.sessionId),
        sessionAccess: this.deps.sessionAccess,
        approvalPolicyRegistry: this.#activePolicyRegistry,
        toolCallMarkers: this.#toolCallMarkers,
      },
    );

    this.deps.inputPlanner.recordSuccess(
      attempt.inputMode === 'delta' ? attempt.streamInput! : this.deps.conversationStore.getHistory(),
      attempt.inputMode === 'delta'
        ? { kind: attempt.inputMode }
        : { kind: attempt.inputMode!, previousInput: attempt.streamInput! },
    );

    return { kind: 'completed', outcome, generation: attempt.token };
  }

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
        sessionId: resolveSessionId(this.deps.sessionId),
        ...(args.inputTokensBefore !== undefined ? { inputTokensBefore: args.inputTokensBefore } : {}),
        // The provider reports no post-compaction size: usage.input_tokens is the
        // compaction pass's own input, i.e. the pre-compaction total.
        inputTokensAfter: undefined,
        durationMs: args.durationMs ?? 0,
      },
    ];
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

  async #waitBeforeRetry(attempt: TurnAttempt, delayMs: number): Promise<void> {
    const signal =
      this.#turnSignal && attempt.signal
        ? AbortSignal.any([this.#turnSignal, attempt.signal])
        : this.#turnSignal ?? attempt.signal;
    if (signal?.aborted) throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
    if (!signal) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(Object.assign(new Error('Operation aborted'), { name: 'AbortError' }));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      signal!.addEventListener('abort', onAbort, { once: true });
    });
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

  async #handleApprovalOutcome(
    outcome: Exclude<BuildResultOutcome, { kind: 'response' }>,
    state: ContinuationState,
    activePolicy: ApprovalDecisionPolicy,
    nextCumulativeUsage?: NormalizedUsage,
    previousInputForSurge?: unknown,
  ): Promise<
    { action: 'return'; result: TurnOutcome } | { action: 'loop'; nextPlan: ContinuationPlan; isApproved: boolean }
  > {
    const { kind } = outcome;

    if (kind === 'auto_approve') {
      if (outcome.advisory?.source === 'llm') {
        this.#toolCallMarkers.markToolCallAsLlmAutoApproved(outcome.callId);
      }
      this.deps.logger.debug('Shell command auto-approved by LLM', {
        eventType: 'approval.auto_approved',
        category: 'approval',
        phase: 'approval',
        sessionId: resolveSessionId(this.deps.sessionId),
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
          sessionId: resolveSessionId(this.deps.sessionId),
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
        sessionId: resolveSessionId(this.deps.sessionId),
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

  async *#projectContinuation(
    state: ContinuationState,
    stream: AgentStream,
  ): AsyncGenerator<
    ConversationEvent,
    | { kind: 'stale' }
    | {
        kind: 'completed';
        outcome: BuildResultOutcome;
        nextCumulativeMessages: any[];
        nextCumulativeUsage?: NormalizedUsage;
        nextCumulativeTurnItems: any[];
        mergedEmittedIds: Set<string>;
      },
    void
  > {
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

    const streamMessages = extractCommandMessages(selectAgentStreamItems(stream), this.#toolCallMarkers);
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
        sessionId: resolveSessionId(this.deps.sessionId),
        sessionAccess: this.deps.sessionAccess,
        approvalPolicyRegistry: this.#activePolicyRegistry,
        toolCallMarkers: this.#toolCallMarkers,
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

  #createApprovalRequiredFromAutoApprove(
    outcome: Extract<BuildResultOutcome, { kind: 'auto_approve' }>,
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
