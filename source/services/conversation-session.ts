import type { ILoggingService, ISessionContextService, ISettingsService } from './service-interfaces.js';
import { ConversationStore } from './conversation-store.js';
import type { AgentInputItem } from '@openai/agents';

import { SessionRetryOrchestrator, type RetryState } from './session-retry-orchestrator.js';
import type { ConversationEvent } from './conversation-events.js';
import type { CommandMessage } from '../tools/types.js';
import { type NormalizedUsage } from '../utils/token-usage.js';
import { ApprovalState } from './approval-state.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import type { ConversationTerminal, ReasoningEffortSetting } from '../contracts/conversation.js';
import { collectTerminalResult } from './terminal-result-collector.js';
import { getMethod, getCallIdFromObject } from './interruption-info.js';
import { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import { buildConversationResult } from './conversation-result-builder.js';
import type { AgentStream } from './agent-stream.js';
import { extractReplaySnapshot, extractFinalizationSnapshot, type StreamReplaySnapshot } from './stream-snapshot.js';
import { normalizeUserTurn, type UserTurn } from '../types/user-turn.js';
import { type LargeUncachedInputDecision } from './large-uncached-input-guard.js';
import { collectDuplicateToolCallResultPairs } from './input-surge-guard.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { reconcileHistoryWithToolLedger } from './tool-execution-ledger.js';
import { type SavedToolExecution } from './tool-execution-ledger.js';
import type { LogEvent, StateSnapshot } from './conversation-log-events.js';
import { ConversationLogger } from './conversation-logger.js';
import type { PersistedAssistantTurnItem } from './conversation-persistence-types.js';
import type { ConversationAgentClient } from './conversation-agent-client.js';
import { SessionInputPlanner } from './session-input-planner.js';
import { SessionStateController } from './session-state-controller.js';
import { ApprovalContinuationRunner } from './approval-continuation-runner.js';
import { ConversationTurnRunner } from './conversation-turn-runner.js';

export type { CommandMessage };
export type ConversationResult = ConversationTerminal;

type StreamHistorySource = 'startStream' | 'continueRunStream' | 'abortResolution';

type ConversationSessionRetryOptions = {
  /**
   * When false, retries are only allowed if an AgentStream exists so the turn
   * can resume from captured history instead of replaying from the beginning.
   */
  allowFreshStartRetries?: boolean;
};

const warnIfStreamHistoryReplayedTools = ({
  logger,
  sessionId,
  source,
  snapshot,
}: {
  logger: ILoggingService;
  sessionId: string;
  source: StreamHistorySource;
  snapshot: StreamReplaySnapshot;
}): void => {
  const { history, newItems, generatedItems } = snapshot;

  const historyDuplicates = collectDuplicateToolCallResultPairs(history);
  const newItemsDuplicates = collectDuplicateToolCallResultPairs(newItems);
  const stateGeneratedItemsDuplicates = collectDuplicateToolCallResultPairs(generatedItems);

  if (historyDuplicates.pairs === 0 && newItemsDuplicates.pairs === 0 && stateGeneratedItemsDuplicates.pairs === 0) {
    return;
  }

  logger.warn('Completed stream history contains replayed tool call/result pairs', {
    eventType: 'conversation.stream_history.replayed_tools',
    category: 'provider',
    phase: 'post_stream',
    sessionId,
    traceId: logger.getCorrelationId(),
    source,
    historyLength: history.length,
    newItemsLength: newItems.length,
    stateGeneratedItemsLength: generatedItems.length,
    historyDuplicatePairs: historyDuplicates.pairs,
    historyMaxCopies: historyDuplicates.maxCopies,
    newItemsDuplicatePairs: newItemsDuplicates.pairs,
    newItemsMaxCopies: newItemsDuplicates.maxCopies,
    stateGeneratedItemsDuplicatePairs: stateGeneratedItemsDuplicates.pairs,
    stateGeneratedItemsMaxCopies: stateGeneratedItemsDuplicates.maxCopies,
  });
};

export class ConversationSession {
  public readonly id: string;
  public readonly startedAt: string;
  private agentClient: ConversationAgentClient;
  private logger: ILoggingService;
  private conversationStore: ConversationStore;
  private approvalState = new ApprovalState();
  private toolTracker: SessionToolTracker;
  private shellAutoApproval: ShellAutoApprovalResolver;
  private approvalFlow: ApprovalFlowCoordinator;
  private retryOrchestrator: SessionRetryOrchestrator;
  #inputPlanner: SessionInputPlanner;
  #state: SessionStateController;
  #continuationRunner: ApprovalContinuationRunner;
  #turnRunner: ConversationTurnRunner;

  #breakChaining(): void {
    this.retryOrchestrator.breakChaining();
    this.#state.previousResponseId = null;
    this.#inputPlanner.previousResponseId = null;
    this.logger.warn('WS-to-HTTP downgrade detected: chaining disabled, switching to full-history mode', {
      eventType: 'conversation.chaining_broken',
      category: 'provider',
      phase: 'post_stream',
      sessionId: this.id,
    });
  }

  #finalizeStreamOutcome(stream: AgentStream, gen: number, source: StreamHistorySource): void {
    if (!this.retryOrchestrator.isCurrentGeneration(gen)) return;
    const snapshot = extractFinalizationSnapshot(stream);
    this.#state.previousResponseId = snapshot.lastResponseId;
    this.#inputPlanner.previousResponseId = snapshot.lastResponseId;
    warnIfStreamHistoryReplayedTools({
      logger: this.logger,
      sessionId: this.id,
      source,
      snapshot: extractReplaySnapshot(stream),
    });
    const terminal = !stream.interruptions || stream.interruptions.length === 0;
    if (terminal) {
      if (this.retryOrchestrator.inputSurgeKindState === 'delta') {
        this.conversationStore.appendOutput(snapshot.output as AgentInputItem[]);
      } else {
        // For full-history mode, prefer appending only the new items so we
        // don't lose assistant text content that the SDK's history reconstruction
        // may have stripped (e.g. turning assistant+tool_call messages into
        // separate function_call items with null content).
        const outputItems = snapshot.output;
        const newItems = outputItems.length > 0 ? outputItems : snapshot.newItems;
        if (newItems.length > 0) {
          this.conversationStore.appendOutput(newItems as AgentInputItem[]);
        } else if (snapshot.history.length > 0) {
          this.conversationStore.replaceHistory(snapshot.history as AgentInputItem[]);
        }
      }
    }
  }

  private turnAccumulator = new TurnItemAccumulator();

  private settingsService?: ISettingsService;
  private sessionContextService: ISessionContextService;
  private conversationLogger: ConversationLogger;

  constructor(
    id: string,
    {
      agentClient,
      deps,
      sessionStartedAt,
      retryOptions,
    }: {
      agentClient: ConversationAgentClient;
      deps: {
        logger: ILoggingService;
        settingsService?: ISettingsService;
        sessionContextService: ISessionContextService;
      };
      sessionStartedAt?: string;
      retryOptions?: ConversationSessionRetryOptions;
    },
  ) {
    this.id = id;
    this.startedAt = sessionStartedAt ?? new Date().toISOString();
    this.agentClient = agentClient;
    this.logger = deps.logger;
    this.settingsService = deps.settingsService;
    this.sessionContextService = deps.sessionContextService;
    this.conversationStore = new ConversationStore();
    this.toolTracker = new SessionToolTracker(this.conversationStore);
    this.retryOrchestrator = new SessionRetryOrchestrator(
      this.logger,
      this.id,
      this.agentClient,
      retryOptions?.allowFreshStartRetries ?? true,
    );
    this.shellAutoApproval = new ShellAutoApprovalResolver({
      conversationStore: this.conversationStore,
      agentClient: this.agentClient,
      logger: this.logger,
      settingsService: this.settingsService,
      sessionContextService: this.sessionContextService,
    });
    this.#inputPlanner = new SessionInputPlanner({
      settingsService: deps.settingsService,
      agentClient,
      toolTracker: this.toolTracker,
      retryOrchestrator: this.retryOrchestrator,
    });

    this.#state = new SessionStateController({
      retryOrchestrator: this.retryOrchestrator,
      inputPlanner: this.#inputPlanner,
      approvalState: this.approvalState,
      toolTracker: this.toolTracker,
      shellAutoApproval: this.shellAutoApproval,
      turnAccumulator: this.turnAccumulator,
      conversationStore: this.conversationStore,
      agentClient,
      logger: this.logger,
      sessionId: this.id,
    });

    this.conversationLogger = new ConversationLogger({
      turnAccumulator: this.turnAccumulator,
      logger: this.logger,
      getAssistantTurnState: () => {
        const fn = getMethod<[], string>(this.agentClient, 'getProvider');
        const provider = fn ? fn.call(this.agentClient) : this.settingsService?.get<string>('agent.provider');
        const model = this.settingsService?.get<string>('agent.model');
        return {
          previousResponseId: this.#state.previousResponseId,
          ...(model ? { model } : {}),
          ...(provider ? { provider } : {}),
        };
      },
      getToolLedger: () => this.toolTracker.export(),
    });
    this.approvalFlow = new ApprovalFlowCoordinator({
      agentClient: this.agentClient,
      approvalState: this.approvalState,
      logger: this.logger,
      sessionId: this.id,
    });

    this.#continuationRunner = new ApprovalContinuationRunner({
      agentClient,
      approvalFlow: this.approvalFlow,
      toolTracker: this.toolTracker,
      conversationStore: this.conversationStore,
      conversationLogger: this.conversationLogger,
      retryOrchestrator: this.retryOrchestrator,
      inputPlanner: this.#inputPlanner,
      state: this.#state,
      logger: this.logger,
      sessionId: this.id,
      dedupeToolStarted: (event) => this.#dedupeToolStarted(event),
      finalizeStreamOutcome: (stream, gen, source) => this.#finalizeStreamOutcome(stream, gen, source),
      buildAndResolve: (result, finalOutputOverride, reasoningOutputOverride, emittedCommandIds, usage) =>
        this.#buildAndResolve(result, finalOutputOverride, reasoningOutputOverride, emittedCommandIds, usage),
      restartTurn: (turn, options) => this.run(turn, { ...options }),
    });

    this.#turnRunner = new ConversationTurnRunner({
      agentClient,
      logger: this.logger,
      sessionId: this.id,
      turnAccumulator: this.turnAccumulator,
      retryOrchestrator: this.retryOrchestrator,
      toolTracker: this.toolTracker,
      conversationStore: this.conversationStore,
      conversationLogger: this.conversationLogger,
      approvalFlow: this.approvalFlow,
      shellAutoApproval: this.shellAutoApproval,
      inputPlanner: this.#inputPlanner,
      state: this.#state,
      breakChaining: () => this.#breakChaining(),
      finalizeStreamOutcome: (stream, gen, source) => this.#finalizeStreamOutcome(stream, gen, source),
      dedupeToolStarted: (event) => this.#dedupeToolStarted(event),
      buildAndResolve: (result, finalOutputOverride, reasoningOutputOverride, emittedCommandIds, usage) =>
        this.#buildAndResolve(result, finalOutputOverride, reasoningOutputOverride, emittedCommandIds, usage),
      isCurrentGeneration: (gen) => this.#isCurrentGeneration(gen),
    });

    // When the WS transport degrades to HTTP for a provider that requires
    // WS for conversation chaining, sever the chain and switch to full-history
    // mode for the rest of the session.
    if (typeof this.agentClient.onDowngrade === 'function') {
      this.agentClient.onDowngrade(() => this.#breakChaining());
    }
  }

  previewLargeUncachedInput(input: string | UserTurn, now = Date.now()): LargeUncachedInputDecision {
    return this.#inputPlanner.previewLargeUncachedInput(input, now, {
      pendingModeNotice: this.#state.pendingModeNotice,
    });
  }

  #getFirstUserMessagePreview(currentTurn?: string): string {
    const [firstTurn] = this.conversationStore.listUserTurns();
    return firstTurn?.text ?? currentTurn ?? '';
  }

  #withTrafficContext<T>(currentTurn: string | undefined, fn: () => T): T {
    // Re-derive traffic mode via the agent client directly since the planner
    // is the only object that encapsulates settings-based mode decisions.
    const mode = this.#getTrafficMode();
    return this.sessionContextService.runWithContext(
      {
        sessionId: this.id,
        sessionStartedAt: this.startedAt,
        firstUserMessagePreview: this.#getFirstUserMessagePreview(currentTurn),
        mode,
        traceId: this.logger.getCorrelationId(),
      },
      fn,
    );
  }

  /** Mode string derived from settings, kept for traffic context. */
  #getTrafficMode(): string {
    if (!this.settingsService) return 'standard';
    if (this.settingsService.get<boolean>('app.orchestratorMode')) return 'orchestrator';
    if (this.settingsService.get<boolean>('app.liteMode')) return 'lite';
    if (this.settingsService.get<boolean>('app.planMode')) return 'plan';
    if (this.settingsService.get<boolean>('app.mentorMode')) return 'mentor';
    return 'standard';
  }

  #isCurrentGeneration(gen: number): boolean {
    return this.retryOrchestrator.isCurrentGeneration(gen);
  }

  #afterUndo(count: number): void {
    this.#state.afterUndo();
    this.conversationLogger.log({ type: 'undo', removedUserTurns: count, snapshot: this.getCurrentSnapshot() });
  }

  reset(): void {
    this.#state.resetSession();
  }

  undoLastUserTurn(): { text: string; images?: UserTurn['images'] } | null {
    const removed = this.conversationStore.removeLastUserTurn();
    if (removed === null) return null;
    this.#afterUndo(1);
    return removed;
  }

  listUserTurns(): { index: number; text: string; imageCount: number }[] {
    return this.conversationStore.listUserTurns();
  }

  undoNUserTurns(n: number): { text: string; images?: UserTurn['images'] } | null {
    const removed = this.conversationStore.removeNLastUserTurns(n);
    if (removed === null) return null;
    this.#afterUndo(n);
    return removed;
  }

  setModel(model: string): void {
    this.#state.afterProviderChanged();
    this.agentClient.setModel(model);
  }

  setReasoningEffort(effort: ReasoningEffortSetting): void {
    this.#state.afterProviderChanged();
    const setReasoningEffort = getMethod<[ReasoningEffortSetting], void>(this.agentClient, 'setReasoningEffort');
    setReasoningEffort?.call(this.agentClient, effort);
  }

  setTemperature(temperature?: number): void {
    this.#state.afterProviderChanged();
    const setTemperature = getMethod<[number | undefined], void>(this.agentClient, 'setTemperature');
    setTemperature?.call(this.agentClient, temperature);
  }

  setProvider(provider: string): void {
    this.#state.afterProviderChanged();
    const setProvider = getMethod<[string], void>(this.agentClient, 'setProvider');
    setProvider?.call(this.agentClient, provider);
  }

  /** Alias for setProvider, kept for public API surface. */
  switchProvider(provider: string): void {
    this.setProvider(provider);
  }

  setRetryCallback(callback: () => void): void {
    if (typeof this.agentClient.setRetryCallback === 'function') {
      this.agentClient.setRetryCallback(callback);
    }
  }

  setLogSink(sink: ((event: LogEvent) => void) | null): void {
    this.conversationLogger.setLogSink(sink);
  }

  getCurrentSnapshot(): StateSnapshot {
    const providerFn = getMethod<[], string>(this.agentClient, 'getProvider');
    const provider = providerFn
      ? providerFn.call(this.agentClient)
      : this.settingsService?.get<string>('agent.provider');
    const model = this.settingsService?.get<string>('agent.model');
    return {
      history: reconcileHistoryWithToolLedger(this.conversationStore.getHistory(), this.toolTracker.export())
        .history as AgentInputItem[],
      previousResponseId: this.#state.previousResponseId,
      toolLedger: this.toolTracker.export(),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    };
  }

  #dedupeToolStarted(event: ConversationEvent): ConversationEvent | null {
    return this.toolTracker.dedupeToolStarted(event);
  }

  /** Used in tests to seed the input surge guard baseline. */
  __testSeedInputSurgeBaseline(data: unknown[], kind: 'delta' | 'full_history'): void {
    this.#inputPlanner.recordSuccess(data, { kind, previousInput: undefined });
  }

  exportState(): {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger: SavedToolExecution[];
  } {
    return this.#state.exportPersistedState();
  }

  importState(state: {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger?: SavedToolExecution[];
    updatedAt?: string;
  }): void {
    this.#state.importPersistedState(state);
  }

  addShellContext(historyText: string): void {
    this.conversationStore.addShellContext(historyText);
  }
  queueModeNotice(text: string): void {
    this.#state.pendingModeNotice = text;
  }
  /**
   * Abort the current running operation
   */
  abort(): void {
    const pending = this.approvalFlow.getPending();
    const callId = pending ? getCallIdFromObject(pending.interruption) : undefined;
    if (this.approvalFlow.abort()) {
      this.toolTracker.recordAbortedApproval(
        'Tool execution was not approved.',
        'Tool execution was not approved.',
        callId,
      );
    }
  }

  /**
   * Phase 4: stream conversation events as an async iterator.
   *
   * This is the transport-friendly primitive that can later be bridged to SSE/WebSockets.
   */
  async *run(
    input: string | UserTurn,
    {
      skipUserMessage = false,
      retries = {},
      maxModelRetries,
      signal,
      resumeState,
    }: {
      skipUserMessage?: boolean;
      retries?: RetryState;
      maxModelRetries?: number;
      signal?: AbortSignal;
      resumeState?: unknown;
    } = {},
  ): AsyncIterable<ConversationEvent> {
    yield* this.#turnRunner.run(input, {
      skipUserMessage,
      retries,
      maxModelRetries,
      signal,
      resumeState,
    });
  }

  /**
   * Continue a session after an approval decision.
   * Delegates to the ApprovalContinuationRunner.
   */
  async *continueAfterApproval({
    answer,
    rejectionReason,
  }: {
    answer: string;
    rejectionReason?: string;
  }): AsyncIterable<ConversationEvent> {
    yield* this.#continuationRunner.continueAfterApproval({
      answer,
      rejectionReason,
      generation: this.retryOrchestrator.currentGeneration,
    });
  }

  async sendMessage(
    input: string | UserTurn,
    {
      onTextChunk,
      onReasoningChunk,
      onCommandMessage,
      onEvent,
      hallucinationRetryCount = 0,
    }: {
      onTextChunk?: (fullText: string, chunk: string) => void;
      onReasoningChunk?: (fullText: string, chunk: string) => void;
      onCommandMessage?: (message: CommandMessage) => void;
      onEvent?: (event: ConversationEvent) => void;
      hallucinationRetryCount?: number;
    } = {},
  ): Promise<ConversationResult> {
    const turn = normalizeUserTurn(input);
    return this.#withTrafficContext(turn.text, async () => {
      const wrappedOnEvent = (event: ConversationEvent) => {
        this.conversationLogger.dispatchEventToLog(event);
        onEvent?.(event);
      };
      getMethod<[((event: ConversationEvent) => void) | null], void>(this.agentClient, 'setSubagentEventSink')?.call(
        this.agentClient,
        wrappedOnEvent,
      );
      let result: ConversationResult;
      try {
        result = await collectTerminalResult(this.run(input, { retries: { hallucinationRetryCount } }), {
          onTextChunk,
          onReasoningChunk,
          onCommandMessage,
          onEvent: wrappedOnEvent,
          getRawInterruption: () => this.approvalFlow.getPendingInterruption(),
          onFinalEvent: (event) => {
            this.logger.debug('sendMessage received final event', {
              sessionId: this.id,
              hasUsage: Boolean(event.usage),
              usage: event.usage,
            });
          },
        });
      } finally {
        getMethod<[((event: ConversationEvent) => void) | null], void>(this.agentClient, 'setSubagentEventSink')?.call(
          this.agentClient,
          null,
        );
      }

      if (result.type === 'response') {
        this.logger.debug('sendMessage returning response', {
          sessionId: this.id,
          hasUsage: Boolean(result.usage),
          usage: result.usage,
        });
      }

      return result;
    });
  }

  async handleApprovalDecision(
    answer: string,
    rejectionReason?: string,
    {
      onTextChunk,
      onReasoningChunk,
      onCommandMessage,
      onEvent,
      approvalAnswer,
    }: {
      onTextChunk?: (fullText: string, chunk: string) => void;
      onReasoningChunk?: (fullText: string, chunk: string) => void;
      onCommandMessage?: (message: CommandMessage) => void;
      onEvent?: (event: ConversationEvent) => void;
      approvalAnswer?: string;
    } = {},
  ): Promise<ConversationResult | null> {
    if (!this.approvalFlow.getPending()) {
      return null;
    }

    if (answer === 'y' && approvalAnswer) {
      const pending = this.approvalFlow.getPending();
      const callId = pending ? getCallIdFromObject(pending.interruption) : undefined;
      if (callId) {
        this.agentClient.setAskUserAnswer(callId, approvalAnswer);
      }
    }

    this.conversationLogger.log({
      type: 'approval_resolved',
      answer: answer === 'y' ? 'y' : 'n',
      ...(rejectionReason ? { rejectionReason } : {}),
    });
    return this.#withTrafficContext(undefined, async () => {
      const wrappedOnEvent = (event: ConversationEvent) => {
        this.conversationLogger.dispatchEventToLog(event);
        onEvent?.(event);
      };
      getMethod<[((event: ConversationEvent) => void) | null], void>(this.agentClient, 'setSubagentEventSink')?.call(
        this.agentClient,
        wrappedOnEvent,
      );
      let result: ConversationResult | null;
      try {
        result = await collectTerminalResult(this.continueAfterApproval({ answer, rejectionReason }), {
          onTextChunk,
          onReasoningChunk,
          onCommandMessage,
          onEvent: wrappedOnEvent,
          getRawInterruption: () => this.approvalFlow.getPendingInterruption(),
          onFinalEvent: (event) => {
            this.logger.debug('handleApprovalDecision received final event', {
              sessionId: this.id,
              hasUsage: Boolean(event.usage),
              usage: event.usage,
            });
          },
        });
      } finally {
        getMethod<[((event: ConversationEvent) => void) | null], void>(this.agentClient, 'setSubagentEventSink')?.call(
          this.agentClient,
          null,
        );
      }

      if (result.type === 'response') {
        this.logger.debug('handleApprovalDecision returning response', {
          sessionId: this.id,
          hasUsage: Boolean(result.usage),
          usage: result.usage,
        });
      }

      return result;
    });
  }

  async *#buildAndResolve(
    result: AgentStream,
    finalOutputOverride: string | undefined,
    reasoningOutputOverride: string | undefined,
    emittedCommandIds: Set<string> | undefined,
    usage: NormalizedUsage | undefined,
  ): AsyncGenerator<ConversationEvent, ConversationResult, void> {
    const outcome = await buildConversationResult(
      {
        result,
        finalOutputOverride,
        reasoningOutputOverride,
        emittedCommandIds,
        usage,
        toolCallArgumentsById: this.toolTracker.argumentsById,
        turnItems: this.turnAccumulator.getTurnItems(),
      },
      {
        approvalFlow: this.approvalFlow,
        shellAutoApproval: this.shellAutoApproval,
        logger: this.logger,
        sessionId: this.id,
      },
    );

    if (outcome.kind !== 'auto_approve') {
      return outcome.result;
    }

    let finalText = '';
    let reasoningText = '';
    let finalUsage: NormalizedUsage | undefined;
    let continuationApprovalUsage: NormalizedUsage | undefined;
    const commandMessages: CommandMessage[] = [];
    let approvalRequiredResult: ConversationResult | undefined;
    let continuationTurnItems: PersistedAssistantTurnItem[] | undefined;

    for await (const event of this.#continuationRunner.continueAfterApproval({
      answer: 'y',
      generation: this.retryOrchestrator.currentGeneration,
    })) {
      if (event.type === 'approval_required') {
        continuationApprovalUsage = event.usage;
        // The continuation resumes the same live RunState, so its usage
        // accumulator is already cumulative for the whole run (it includes the
        // first, auto-approved turn). Prefer it directly; only fall back to the
        // first turn's usage if the continuation didn't report any.
        const mergedUsage = continuationApprovalUsage ?? usage;
        const usagePatch = mergedUsage && Object.keys(mergedUsage).length > 0 ? { usage: mergedUsage } : {};

        // collectTerminalResult returns on the first approval_required event, so
        // attach the run-cumulative usage onto the event itself.
        yield { ...event, ...usagePatch };

        approvalRequiredResult = {
          type: 'approval_required',
          approval: {
            ...event.approval,
            rawInterruption: this.approvalFlow.getPendingInterruption(),
          },
          ...usagePatch,
        };
      } else if (event.type === 'final') {
        finalText = event.finalText;
        reasoningText = event.reasoningText ?? '';
        finalUsage = event.usage;
        if (event.commandMessages) {
          commandMessages.push(...event.commandMessages);
        }
        if (event.turnItems) {
          continuationTurnItems = event.turnItems;
        }
      } else {
        yield event;
      }
    }

    if (approvalRequiredResult) {
      return approvalRequiredResult;
    }

    // finalUsage comes from the continuation, which reused the same live
    // RunState and therefore already accumulated the first (auto-approved)
    // turn. Prefer it; fall back to the first turn's usage only when the
    // continuation produced none.
    const combinedUsage = finalUsage ?? usage;
    return {
      type: 'response',
      commandMessages,
      finalText: finalText || 'Done.',
      ...(reasoningText ? { reasoningText } : {}),
      ...(combinedUsage && Object.keys(combinedUsage).length > 0 ? { usage: combinedUsage } : {}),
      turnItems: continuationTurnItems ?? this.turnAccumulator.getTurnItems(),
    };
  }
}
