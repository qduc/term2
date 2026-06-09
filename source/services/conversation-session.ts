import type { ILoggingService, ISessionContextService, ISettingsService } from './service-interfaces.js';
import { ConversationStore } from './conversation-store.js';
import type { AgentInputItem } from '@openai/agents';
import { getMaxTransientRetries } from './conversation-retry-policy.js';

import { SessionRetryOrchestrator, type RetryState } from './session-retry-orchestrator.js';
import type { ConversationEvent } from './conversation-events.js';
import type { CommandMessage } from '../tools/types.js';
import { type NormalizedUsage } from '../utils/token-usage.js';
import { getProvider } from '../providers/index.js';
import { ApprovalState } from './approval-state.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import type { ConversationTerminal, ReasoningEffortSetting } from '../contracts/conversation.js';
import { collectTerminalResult } from './terminal-result-collector.js';
import { getMethod, getCallIdFromObject } from './interruption-info.js';
import { createStreamAccumulator, processStreamEvents } from './stream-event-processor.js';
import { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import { buildConversationResult, toTerminalEvent } from './conversation-result-builder.js';
import type { AgentStream } from './agent-stream.js';
import { extractReplaySnapshot, extractFinalizationSnapshot, type StreamReplaySnapshot } from './stream-snapshot.js';
import { normalizeUserTurn, type UserTurn } from '../types/user-turn.js';
import { collectDuplicateToolCallResultPairs, InputSurgeGuard } from './input-surge-guard.js';
import { LargeUncachedInputGuard, type LargeUncachedInputDecision } from './large-uncached-input-guard.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { reconcileHistoryWithToolLedger } from './tool-execution-ledger.js';
import { type SavedToolExecution, callIdOf, toolNameOf, outputOf } from './tool-execution-ledger.js';
import type { LogEvent, StateSnapshot } from './conversation-log-events.js';
import { ConversationLogger } from './conversation-logger.js';
import { describeError } from '../utils/error-helpers.js';
import { ChainingTransportDowngradeError } from '../providers/fallback-responses-model.js';
import type { PersistedAssistantTurnItem } from './conversation-persistence-types.js';
import type { ConversationAgentClient } from './conversation-agent-client.js';

export type { CommandMessage };
export type ConversationResult = ConversationTerminal;

const supportsConversationChaining = (providerId: string): boolean => {
  const providerDef = getProvider(providerId);
  return providerDef?.capabilities?.supportsConversationChaining ?? false;
};

type RetryHandlerContext = {
  error: unknown;
  turn: UserTurn;
  gen: number;
  stream: AgentStream | null;
  streamInput: string | AgentInputItem | AgentInputItem[];
  addedUserMessage: boolean;
  ledgerSnapshot: SavedToolExecution[];
  retries: RetryState;
  maxTransientRetries: number;
  maxModelRetries?: number;
};

type BuiltOutgoingInput = {
  streamInput: string | AgentInputItem | AgentInputItem[];
  inputSurgeKind: 'delta' | 'full_history';
};

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
  private previousResponseId: string | null = null;
  private approvalState = new ApprovalState();
  private toolTracker: SessionToolTracker;
  private shellAutoApproval: ShellAutoApprovalResolver;
  private approvalFlow: ApprovalFlowCoordinator;
  private inputSurgeGuard = new InputSurgeGuard();
  private largeUncachedInputGuard = new LargeUncachedInputGuard();
  private retryOrchestrator: SessionRetryOrchestrator;

  #breakChaining(): void {
    this.retryOrchestrator.breakChaining();
    this.previousResponseId = null;
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
    this.previousResponseId = snapshot.lastResponseId;
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

  #restoreCompletedToolLedgerEntries(snapshot: SavedToolExecution[]): void {
    this.toolTracker.restoreCompletedEntries(snapshot);
  }

  #recoverApprovedToolResultsFromState(state: unknown, expectedCallIds: readonly string[]): void {
    this.toolTracker.recoverApprovedResultsFromState(state, expectedCallIds);
  }

  private turnAccumulator = new TurnItemAccumulator();

  private settingsService?: ISettingsService;
  private sessionContextService: ISessionContextService;
  private pendingModeNotice: string | null = null;
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
    this.conversationLogger = new ConversationLogger({
      turnAccumulator: this.turnAccumulator,
      logger: this.logger,
      getAssistantTurnState: () => {
        const provider = this.#getCurrentProvider(true);
        const model = this.settingsService?.get<string>('agent.model');
        return {
          previousResponseId: this.previousResponseId,
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

    // When the WS transport degrades to HTTP for a provider that requires
    // WS for conversation chaining, sever the chain and switch to full-history
    // mode for the rest of the session.
    if (typeof this.agentClient.onDowngrade === 'function') {
      this.agentClient.onDowngrade(() => this.#breakChaining());
    }
  }

  #getTrafficMode(): string {
    if (!this.settingsService) return 'standard';
    if (this.settingsService.get<boolean>('app.orchestratorMode')) return 'orchestrator';
    if (this.settingsService.get<boolean>('app.liteMode')) return 'lite';
    if (this.settingsService.get<boolean>('app.planMode')) return 'plan';
    if (this.settingsService.get<boolean>('app.mentorMode')) return 'mentor';
    return 'standard';
  }

  #getModelForGuard(): string | null {
    return this.settingsService?.get<string>('agent.model') ?? null;
  }

  #getReasoningEffortForGuard(): string | null {
    return this.settingsService?.get<string>('agent.reasoningEffort') ?? null;
  }

  #getCurrentProvider(nullable: true): string | null;
  #getCurrentProvider(nullable?: false): string;
  #getCurrentProvider(nullable?: boolean): string | null {
    const fn = getMethod<[], string>(this.agentClient, 'getProvider');
    const result = fn ? fn.call(this.agentClient) : this.settingsService?.get<string>('agent.provider');
    return nullable ? result ?? null : result!;
  }

  #getProviderForGuard(): string | null {
    return this.#getCurrentProvider(true);
  }

  #recordInputSurgeSuccess(input: unknown, options: { kind: 'delta' | 'full_history'; previousInput?: unknown }): void {
    this.inputSurgeGuard.recordSuccessfulInput(input, options);
    this.largeUncachedInputGuard.recordSuccessfulInput({
      input,
      now: Date.now(),
      provider: this.#getProviderForGuard(),
      model: this.#getModelForGuard(),
      reasoningEffort: this.#getReasoningEffortForGuard(),
      mode: this.#getTrafficMode(),
    });
  }

  #makeUserInputItem(turn: UserTurn): AgentInputItem {
    const images = turn.images ?? [];
    if (images.length === 0) {
      return { role: 'user', type: 'message', content: turn.text ?? '' };
    }

    const content: any[] = [];
    if (turn.text) {
      content.push({ type: 'input_text', text: turn.text });
    }
    for (const image of images) {
      content.push({
        type: 'input_image',
        image: `data:${image.mimeType};base64,${image.data}`,
        detail: 'auto',
      });
    }

    return { role: 'user', type: 'message', content } as AgentInputItem;
  }

  #turnWithModeNotice(turn: UserTurn, notice: string | null): UserTurn {
    if (!notice?.trim()) {
      return turn;
    }

    const text = turn.text ? `${notice}\n\n${turn.text}` : notice;
    return { ...turn, text };
  }

  #buildOutgoingInput(turn: UserTurn, { includeTurn }: { includeTurn: boolean }): BuiltOutgoingInput {
    const provider = this.#getProviderForGuard() ?? 'openai';
    const supportsChaining = supportsConversationChaining(provider);
    const history = this.toolTracker.getReconciledHistory();
    const effectiveTurn = includeTurn ? this.#turnWithModeNotice(turn, this.pendingModeNotice) : turn;
    const outgoingHistory = includeTurn ? [...history, this.#makeUserInputItem(effectiveTurn)] : history;
    const useChaining =
      supportsChaining &&
      !this.retryOrchestrator.chainingBrokenState &&
      (!!this.previousResponseId || outgoingHistory.length <= 1);
    const latestInput = outgoingHistory[outgoingHistory.length - 1] ?? effectiveTurn.text;
    const chainedInput = effectiveTurn.images?.length ? latestInput : effectiveTurn.text;

    return {
      streamInput: useChaining ? (typeof chainedInput === 'string' ? chainedInput : [chainedInput]) : outgoingHistory,
      inputSurgeKind: useChaining ? 'delta' : 'full_history',
    };
  }

  previewLargeUncachedInput(input: string | UserTurn, now = Date.now()): LargeUncachedInputDecision {
    const turn = normalizeUserTurn(input);
    const { streamInput } = this.#buildOutgoingInput(turn, { includeTurn: true });
    return this.largeUncachedInputGuard.inspect({
      input: streamInput,
      now,
      provider: this.#getProviderForGuard(),
      model: this.#getModelForGuard(),
      reasoningEffort: this.#getReasoningEffortForGuard(),
      mode: this.#getTrafficMode(),
    });
  }

  #getFirstUserMessagePreview(currentTurn?: string): string {
    const [firstTurn] = this.conversationStore.listUserTurns();
    return firstTurn?.text ?? currentTurn ?? '';
  }

  #withTrafficContext<T>(currentTurn: string | undefined, fn: () => T): T {
    return this.sessionContextService.runWithContext(
      {
        sessionId: this.id,
        sessionStartedAt: this.startedAt,
        firstUserMessagePreview: this.#getFirstUserMessagePreview(currentTurn),
        mode: this.#getTrafficMode(),
        traceId: this.logger.getCorrelationId(),
      },
      fn,
    );
  }

  #isCurrentGeneration(gen: number): boolean {
    return this.retryOrchestrator.isCurrentGeneration(gen);
  }

  #resetProviderContinuity({ clearConversations = true }: { clearConversations?: boolean } = {}): void {
    this.retryOrchestrator.incrementGeneration();
    this.previousResponseId = null;
    this.approvalState.clearPending();
    this.approvalState.consumeAborted();
    this.toolTracker.clearArguments();
    this.toolTracker.clearEmittedToolStarted();
    this.shellAutoApproval.clearCache();
    this.inputSurgeGuard.reset();
    this.turnAccumulator.resetPersistedTurnState();

    if (clearConversations) {
      const clearConversationsFn = getMethod<[], void>(this.agentClient, 'clearConversations');
      clearConversationsFn?.call(this.agentClient);
    }
  }

  #pruneToolLedgerToCurrentHistory(): void {
    this.toolTracker.pruneToCurrentHistory();
  }

  #setInputSurgeKind(kind: 'delta' | 'full_history'): void {
    const current = this.retryOrchestrator.inputSurgeKindState;
    if (kind !== current) {
      this.logger.debug('Input surge kind changed', {
        eventType: 'session.input_surge_kind_changed',
        from: current,
        to: kind,
        sessionId: this.id,
      });
    }
    this.retryOrchestrator.setInputSurgeKind(kind);
  }

  #commonRestoreForRetry(
    ledgerSnapshot: SavedToolExecution[],
    stream: AgentStream | null,
    extras?: { removeLastUserMessage?: boolean },
  ): void {
    this.retryOrchestrator.restoreForRetry({
      ledgerSnapshot,
      stream,
      toolLedger: this.toolTracker.ledger,
      conversationStore: this.conversationStore,
      clearPreviousResponseId: () => {
        this.previousResponseId = null;
      },
      restoreCompletedToolLedgerEntries: (snapshot) => this.#restoreCompletedToolLedgerEntries(snapshot),
      ...(extras?.removeLastUserMessage
        ? { removeLastUserMessage: () => this.conversationStore.removeLastUserMessage() }
        : {}),
    });
  }

  #afterUndo(count: number): void {
    this.#pruneToolLedgerToCurrentHistory();
    this.#resetProviderContinuity();
    this.largeUncachedInputGuard.markUndoOrRewind();
    this.#setInputSurgeKind('delta');
    this.conversationLogger.log({ type: 'undo', removedUserTurns: count, snapshot: this.getCurrentSnapshot() });
  }

  reset(): void {
    this.#resetProviderContinuity();
    this.conversationStore.clear();
    this.toolTracker.reset();
    this.largeUncachedInputGuard.reset();
    this.#setInputSurgeKind('delta');
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
    this.#resetProviderContinuity();
    this.agentClient.setModel(model);
  }

  setReasoningEffort(effort: ReasoningEffortSetting): void {
    this.#resetProviderContinuity();
    const setReasoningEffort = getMethod<[ReasoningEffortSetting], void>(this.agentClient, 'setReasoningEffort');
    setReasoningEffort?.call(this.agentClient, effort);
  }

  setTemperature(temperature?: number): void {
    this.#resetProviderContinuity();
    const setTemperature = getMethod<[number | undefined], void>(this.agentClient, 'setTemperature');
    setTemperature?.call(this.agentClient, temperature);
  }

  setProvider(provider: string): void {
    this.#resetProviderContinuity();
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
    const provider = this.#getCurrentProvider(true);
    const model = this.settingsService?.get<string>('agent.model');
    return {
      history: reconcileHistoryWithToolLedger(this.conversationStore.getHistory(), this.toolTracker.export())
        .history as AgentInputItem[],
      previousResponseId: this.previousResponseId,
      toolLedger: this.toolTracker.export(),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    };
  }

  #dedupeToolStarted(event: ConversationEvent): ConversationEvent | null {
    return this.toolTracker.dedupeToolStarted(event);
  }

  exportState(): {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger: SavedToolExecution[];
  } {
    return {
      history: this.toolTracker.getReconciledHistory(),
      previousResponseId: this.previousResponseId,
      toolLedger: this.toolTracker.export(),
    };
  }

  importState(state: {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger?: SavedToolExecution[];
    updatedAt?: string;
  }): void {
    this.conversationStore.clear();
    this.toolTracker.import(state.toolLedger);
    const reconciled = reconcileHistoryWithToolLedger(state.history, state.toolLedger);
    if (reconciled.addedCompletedPairs > 0 || reconciled.droppedIncompleteCalls > 0) {
      this.logger.warn('Reconciled saved conversation history with tool execution ledger', {
        eventType: 'conversation.tool_ledger.reconciled',
        category: 'conversation',
        phase: 'resume',
        sessionId: this.id,
        addedCompletedPairs: reconciled.addedCompletedPairs,
        droppedIncompleteCalls: reconciled.droppedIncompleteCalls,
      });
    }
    for (const item of reconciled.history as import('@openai/agents').AgentInputItem[]) {
      this.conversationStore.addImportedItem(item);
    }
    // Provider-side response chains can expire while the local transcript remains valid.
    // Force the first resumed turn to resync from full history; successful completion
    // will populate a fresh previousResponseId for subsequent chained turns.
    this.previousResponseId = null;
    this.toolTracker.clearEmittedToolStarted();
    this.inputSurgeGuard.reset();
    this.shellAutoApproval.clearCache();
    this.approvalState.clearPending();
    this.approvalState.consumeAborted();
    this.toolTracker.clearArguments();
    this.turnAccumulator.resetPersistedTurnState();
    this.largeUncachedInputGuard.markResumedSession({
      updatedAtMs: state.updatedAt ? Date.parse(state.updatedAt) : null,
    });
    this.retryOrchestrator.incrementGeneration();
  }

  addShellContext(historyText: string): void {
    this.conversationStore.addShellContext(historyText);
  }
  queueModeNotice(text: string): void {
    this.pendingModeNotice = text;
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
    const {
      transientRetryCount = 0,
      flexServiceTierFallbackCount = 0,
      hallucinationRetryCount = 0,
      transportFallbackRetryCount = 0,
    } = retries;
    if (
      !skipUserMessage ||
      hallucinationRetryCount > 0 ||
      flexServiceTierFallbackCount > 0 ||
      transientRetryCount > 0 ||
      transportFallbackRetryCount > 0
    ) {
      this.turnAccumulator.resetPersistedTurnState();
    }
    const gen = this.retryOrchestrator.currentGeneration;
    let stream: AgentStream | null = null;
    let streamInput: string | AgentInputItem | AgentInputItem[] = '';
    let inputSurgeKind: 'delta' | 'full_history' = 'delta';
    const turn = this.#turnWithModeNotice(normalizeUserTurn(input), this.pendingModeNotice);
    const text = turn.text;
    let addedUserMessage = false;
    const ledgerSnapshot = this.toolTracker.export();
    const maxTransientRetries = getMaxTransientRetries({
      streamMaxRetries: getMethod<[], number | undefined>(this.agentClient, 'getStreamMaxRetries')?.call(
        this.agentClient,
      ),
    });
    this.toolTracker.ledger.beginTurn();
    let abortListener: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        this.agentClient.abort();
        throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
      }
      abortListener = () => {
        this.agentClient.abort();
      };
      signal.addEventListener('abort', abortListener);
    }
    try {
      this.logger.debug('Conversation stream start', {
        eventType: 'stream.started',
        category: 'stream',
        phase: 'request_start',
        sessionId: this.id,
        traceId: this.logger.getCorrelationId(),
      });
      const abortedContext = this.approvalFlow.consumeAborted();
      const shouldAddUserMessage = !skipUserMessage && !abortedContext;

      // Maintain canonical local history regardless of provider.
      if (shouldAddUserMessage) {
        this.conversationStore.addUserTurn(turn);
        addedUserMessage = true;
      } else if (abortedContext && !skipUserMessage) {
        // The UI appended a user message for this input, but the store will consume it
        // as fake tool output for the aborted approval rather than as a new user turn.
        // Signal the UI to mark it so /undo skips it.
        yield { type: 'user_message_consumed_for_abort' };
      }

      // If there's an aborted approval, we need to resolve it first.
      // The user's message is a new input, but the agent is stuck waiting for tool output.
      if (abortedContext) {
        this.logger.debug('Resolving aborted approval with fake execution', {
          message: text,
        });

        // Restore cached tool-call arguments captured before abort so continuation can attach them
        this.toolTracker.clearArguments();
        if (abortedContext.toolCallArgumentsById?.size) {
          for (const [key, value] of abortedContext.toolCallArgumentsById.entries()) {
            this.toolTracker.argumentsById.set(key, value);
          }
        }

        const { removeInterceptor } = this.approvalFlow.prepareAbortResolution(abortedContext, text);

        try {
          const previousInputForSurge =
            this.retryOrchestrator.inputSurgeKindState === 'full_history'
              ? this.conversationStore.getHistory()
              : undefined;
          const continuedStream = (await this.agentClient.continueRunStream(abortedContext.state, {
            previousResponseId: this.previousResponseId,
            sessionId: this.id,
            toolResultCallIds: [getCallIdFromObject(abortedContext.interruption)].filter(
              (callId): callId is string => typeof callId === 'string' && callId.length > 0,
            ),
          })) as AgentStream;

          const acc = createStreamAccumulator();
          acc.emittedCommandIds = new Set<string>(abortedContext.emittedCommandIds);
          for await (const event of processStreamEvents(
            continuedStream,
            acc,
            {
              toolCallArgumentsById: this.toolTracker.argumentsById,
              emittedInvalidToolCallPackets: this.toolTracker.invalidPackets,
              preserveExistingToolArgs: true,
              onFunctionCallItem: (item) => this.toolTracker.recordFunctionCall(item),
              onFunctionResultItem: (item) => {
                this.toolTracker.recordFunctionResult(item);
                const cid = callIdOf(item);
                if (cid && this.conversationLogger.hasSink()) {
                  const entry = this.toolTracker.export().find((e) => e.callId === cid);
                  this.conversationLogger.log({
                    type: 'tool_result',
                    callId: cid,
                    toolName: entry?.toolName ?? toolNameOf(item),
                    status: entry?.status === 'failed' || entry?.status === 'aborted' ? entry.status : 'completed',
                    output: entry?.output ?? outputOf(item),
                    ...(entry?.historyItems ? { historyItems: entry.historyItems } : {}),
                  });
                }
              },
            },
            { logger: this.logger, sessionId: this.id },
          )) {
            const filtered = this.#dedupeToolStarted(event);
            if (filtered) yield filtered;
          }

          this.#finalizeStreamOutcome(continuedStream, gen, 'abortResolution');

          if (continuedStream.interruptions && continuedStream.interruptions.length > 0) {
            this.logger.warn('Another interruption occurred after fake execution - handling as approval');
          }

          // Successfully resolved - agent should now have processed the fake rejection
          this.logger.debug('Fake execution completed, agent received rejection message');

          const resolvedResult = yield* this.#buildAndResolve(
            continuedStream,
            acc.finalOutput,
            acc.reasoningOutput,
            acc.emittedCommandIds,
            acc.latestUsage,
          );
          this.#recordInputSurgeSuccess(this.conversationStore.getHistory(), {
            kind: this.retryOrchestrator.inputSurgeKindState,
            previousInput: previousInputForSurge,
          });
          yield toTerminalEvent(resolvedResult);
          return;
        } catch (error) {
          this.logger.warn('Error resolving aborted approval with fake execution', {
            error: error instanceof Error ? error.message : String(error),
          });
          // Fall through to normal message flow
        } finally {
          // Always remove interceptor after use
          removeInterceptor();
        }
      }

      // Normal message flow
      // Use chaining mode only when the provider supports it AND either a valid
      // chain exists (previousResponseId is set) or there is no prior history to
      // resync (fresh start with just the current message). After undo the chain
      // is severed (previousResponseId = null) while prior turns remain in the
      // local store, so we fall back to full-history mode to re-establish context.
      ({ streamInput, inputSurgeKind } = this.#buildOutgoingInput(turn, {
        includeTurn: false,
      }));
      this.#setInputSurgeKind(inputSurgeKind);
      const surgeDecision = this.inputSurgeGuard.inspect(streamInput, { kind: inputSurgeKind });
      if (surgeDecision.action === 'block') {
        let droppedUserMessage: { text: string; imageCount: number } | undefined;
        if (addedUserMessage && this.#isCurrentGeneration(gen)) {
          this.conversationStore.removeLastUserMessage();
          droppedUserMessage = { text: turn.text, imageCount: turn.images?.length ?? 0 };
        }

        this.logger.warn('Input surge guard blocked provider request', {
          eventType: 'input_surge.blocked',
          category: 'provider',
          phase: 'request_start',
          sessionId: this.id,
          traceId: this.logger.getCorrelationId(),
          reason: surgeDecision.reason,
          stats: surgeDecision.stats,
          previousStats: surgeDecision.previousStats,
        });

        yield {
          type: 'error',
          kind: 'input_surge_guard',
          message: `${surgeDecision.reason} Request blocked to prevent runaway context growth. Try /undo or /clear, or compact the conversation history.`,
          ...(droppedUserMessage ? { droppedUserMessage } : {}),
        };
        return;
      }

      if (this.pendingModeNotice) {
        this.pendingModeNotice = null;
      }

      try {
        if (resumeState && typeof this.agentClient.continueRunStream === 'function') {
          stream = (await this.agentClient.continueRunStream(resumeState, {
            previousResponseId: this.previousResponseId,
            sessionId: this.id,
          })) as AgentStream;
        } else {
          stream = (await this.agentClient.startStream(streamInput, {
            previousResponseId: inputSurgeKind === 'delta' ? this.previousResponseId : null,
            sessionId: this.id,
          })) as AgentStream;
        }
      } catch (chainingError) {
        // When WS degrades to HTTP mid-request and the provider requires WS for
        // chaining (e.g. Codex), the model layer throws ChainingTransportDowngradeError.
        // Break chaining and retry with full history.
        if (
          chainingError instanceof ChainingTransportDowngradeError &&
          this.retryOrchestrator.freshStartRetriesAllowed
        ) {
          this.#breakChaining();

          this.logger.warn('ChainingTransportDowngradeError caught, retrying with full history', {
            eventType: 'retry.chaining_downgrade',
            category: 'retry',
            phase: 'retry',
            retryType: 'chaining_downgrade',
            sessionId: this.id,
            traceId: this.logger.getCorrelationId(),
            errorMessage: chainingError instanceof Error ? chainingError.message : String(chainingError),
          });

          const fullHistoryRetry = this.#buildOutgoingInput(turn, { includeTurn: false });
          inputSurgeKind = fullHistoryRetry.inputSurgeKind;
          this.#setInputSurgeKind(inputSurgeKind);
          stream = (await this.agentClient.startStream(fullHistoryRetry.streamInput, {
            previousResponseId: null,
            sessionId: this.id,
          })) as AgentStream;
        } else {
          throw chainingError;
        }
      }

      const acc = createStreamAccumulator();
      for await (const event of processStreamEvents(
        stream,
        acc,
        {
          toolCallArgumentsById: this.toolTracker.argumentsById,
          emittedInvalidToolCallPackets: this.toolTracker.invalidPackets,
          preserveExistingToolArgs: false,
          onFunctionCallItem: (item) => this.toolTracker.recordFunctionCall(item),
          onFunctionResultItem: (item) => this.toolTracker.recordFunctionResult(item),
        },
        { logger: this.logger, sessionId: this.id },
      )) {
        const filtered = this.#dedupeToolStarted(event);
        if (filtered) yield filtered;
      }

      this.#finalizeStreamOutcome(stream, gen, 'startStream');

      const resolvedResult = yield* this.#buildAndResolve(
        stream,
        acc.finalOutput || undefined,
        acc.reasoningOutput || undefined,
        acc.emittedCommandIds,
        acc.latestUsage,
      );

      this.#recordInputSurgeSuccess(
        inputSurgeKind === 'delta' ? streamInput : this.conversationStore.getHistory(),
        inputSurgeKind === 'delta' ? { kind: inputSurgeKind } : { kind: inputSurgeKind, previousInput: streamInput },
      );

      if (resolvedResult.type === 'approval_required') {
        if (resolvedResult.approval.callId) {
          this.toolTracker.recordFunctionCall({
            type: 'function_call',
            callId: resolvedResult.approval.callId,
            name: resolvedResult.approval.toolName,
            arguments: resolvedResult.approval.argumentsText,
          });
        }
        this.logger.debug('Tool approval required', {
          eventType: 'approval.required',
          category: 'approval',
          phase: 'approval',
          sessionId: this.id,
          traceId: this.logger.getCorrelationId(),
          toolName: resolvedResult.approval.toolName,
        });
        yield toTerminalEvent(resolvedResult);
        return;
      }

      yield toTerminalEvent(resolvedResult);
    } catch (error) {
      const handled = yield* this.#handleRetryDecision({
        error,
        turn,
        gen,
        stream,
        streamInput,
        addedUserMessage,
        ledgerSnapshot,
        retries: {
          transientRetryCount,
          flexServiceTierFallbackCount,
          hallucinationRetryCount,
          transportFallbackRetryCount,
        },
        maxTransientRetries,
        maxModelRetries,
      });
      if (handled) return;

      throw error;
    } finally {
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
    }
  }

  /**
   * Classify a streaming error and either retry the turn or yield error/cleanup events.
   * Returns true when the error was handled (retry dispatched or generation stale),
   * false when the caller should throw the original error.
   */
  async *#handleRetryDecision(ctx: RetryHandlerContext): AsyncGenerator<ConversationEvent, boolean> {
    const {
      error,
      turn,
      gen,
      stream,
      streamInput,
      addedUserMessage,
      ledgerSnapshot,
      retries,
      maxTransientRetries,
      maxModelRetries,
    } = ctx;

    const outcome = yield* this.retryOrchestrator.handleRetryDecision({
      error,
      turn,
      gen,
      stream,
      retries,
      maxTransientRetries,
      maxModelRetries,
    });

    switch (outcome.kind) {
      case 'stale_generation':
        return true;
      case 'retry_flex_fallback': {
        getMethod<[], void>(this.agentClient, 'useStandardServiceTierForNextRequest')?.call(this.agentClient);
        this.#commonRestoreForRetry(ledgerSnapshot, stream);
        yield* this.run(turn, outcome.runOptions);
        return true;
      }
      case 'retry_transient': {
        if (outcome.restoreOptions) {
          this.#commonRestoreForRetry(ledgerSnapshot, stream, outcome.restoreOptions);
        }
        yield* this.run(turn, outcome.runOptions);
        return true;
      }
      case 'retry_transport_downgrade': {
        this.#commonRestoreForRetry(ledgerSnapshot, stream, outcome.restoreOptions);
        yield* this.run(turn, outcome.runOptions);
        return true;
      }
      case 'retry_hallucination': {
        if (outcome.hadStream && stream) {
          this.toolTracker.import(ledgerSnapshot);
          if (outcome.addErrorContext) {
            this.conversationStore.addErrorContext(outcome.addErrorContext);
          }
        } else {
          this.conversationStore.removeLastUserMessage();
        }
        yield* this.run(turn, outcome.runOptions);
        return true;
      }
    }

    // Drop the just-added user turn from the store before yielding so the
    // generator-cleanup path doesn't strand the removal — and so the error
    // event can carry the dropped text for UI restoration.
    let droppedUserMessage: { text: string; imageCount: number } | undefined;
    if (addedUserMessage && !stream && this.#isCurrentGeneration(gen)) {
      this.conversationStore.removeLastUserMessage();
      droppedUserMessage = { text: turn.text, imageCount: turn.images?.length ?? 0 };
    }
    if (stream && this.#isCurrentGeneration(gen)) {
      this.toolTracker.markOpenCallsAborted(error instanceof Error ? error.message : String(error));
      const reconciled = reconcileHistoryWithToolLedger(this.conversationStore.getHistory(), this.toolTracker.export());
      if (reconciled.addedCompletedPairs > 0 || reconciled.droppedIncompleteCalls > 0) {
        this.conversationStore.replaceHistory(reconciled.history as AgentInputItem[]);
      }
      this.#recordInputSurgeSuccess(this.conversationStore.getHistory(), {
        kind: 'full_history',
        previousInput: streamInput,
      });
      const recoverySummary = this.toolTracker.getRecoverySummary();
      if (recoverySummary) {
        yield {
          type: 'tool_recovery',
          recoveredCallIds: recoverySummary.recoveredCallIds,
          droppedCallIds: recoverySummary.droppedCallIds,
          message: recoverySummary.message,
        };
      }
    }
    yield {
      type: 'error',
      message: describeError(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      ...(droppedUserMessage ? { droppedUserMessage } : {}),
    };
    this.logger.error('Conversation stream error', {
      eventType: 'stream.failed',
      category: 'stream',
      phase: 'abort',
      sessionId: this.id,
      traceId: this.logger.getCorrelationId(),
      errorMessage: describeError(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return false;
  }

  /**
   * Continue a session after an approval decision.
   */
  async *continueAfterApproval({
    answer,
    rejectionReason,
  }: {
    answer: string;
    rejectionReason?: string;
  }): AsyncIterable<ConversationEvent> {
    const gen = this.retryOrchestrator.currentGeneration;
    const plan = this.approvalFlow.prepareContinuation(answer, rejectionReason);
    if (!plan) {
      return;
    }

    if (answer !== 'y') {
      const interruption = plan.pendingApprovalContext.interruption;
      const callId = getCallIdFromObject(interruption);
      const output = rejectionReason
        ? `Tool execution was not approved. User's reason: ${rejectionReason}`
        : 'Tool execution was not approved.';
      this.toolTracker.recordAbortedApproval(output, output, callId);
    }

    const {
      pendingApprovalContext: { state, interruption, toolCallArgumentsById, emittedCommandIds: previouslyEmittedIds },
      toolStartedEvent,
      removeInterceptor,
    } = plan;
    const ledgerSnapshot = this.toolTracker.export();
    const approvedToolResultCallIds = [getCallIdFromObject(interruption)].filter(
      (callId): callId is string => typeof callId === 'string' && callId.length > 0,
    );
    let stream: AgentStream | null = null;

    if (toolStartedEvent) {
      const filtered = this.#dedupeToolStarted(toolStartedEvent);
      if (filtered) yield filtered;
    }

    // Restore cached tool-call arguments so continuation outputs can attach them
    this.toolTracker.clearArguments();
    if (toolCallArgumentsById?.size) {
      for (const [key, value] of toolCallArgumentsById.entries()) {
        this.toolTracker.argumentsById.set(key, value);
      }
    }

    try {
      let transientRetryCount = 0;
      while (true) {
        try {
          const previousInputForSurge =
            this.retryOrchestrator.inputSurgeKindState === 'full_history'
              ? this.conversationStore.getHistory()
              : undefined;
          stream = (await this.agentClient.continueRunStream(state, {
            previousResponseId: this.previousResponseId,
            sessionId: this.id,
            toolResultCallIds: approvedToolResultCallIds,
          })) as AgentStream;

          const acc = createStreamAccumulator();
          for await (const event of processStreamEvents(
            stream,
            acc,
            {
              toolCallArgumentsById: this.toolTracker.argumentsById,
              emittedInvalidToolCallPackets: this.toolTracker.invalidPackets,
              preserveExistingToolArgs: true,
              onFunctionCallItem: (item) => this.toolTracker.recordFunctionCall(item),
              onFunctionResultItem: (item) => {
                this.toolTracker.recordFunctionResult(item);
                const cid = callIdOf(item);
                if (cid && this.conversationLogger.hasSink()) {
                  const entry = this.toolTracker.export().find((e) => e.callId === cid);
                  this.conversationLogger.log({
                    type: 'tool_result',
                    callId: cid,
                    toolName: entry?.toolName ?? toolNameOf(item),
                    status: entry?.status === 'failed' || entry?.status === 'aborted' ? entry.status : 'completed',
                    output: entry?.output ?? outputOf(item),
                    ...(entry?.historyItems ? { historyItems: entry.historyItems } : {}),
                  });
                }
              },
            },
            { logger: this.logger, sessionId: this.id },
          )) {
            const filtered = this.#dedupeToolStarted(event);
            if (filtered) yield filtered;
          }

          this.#finalizeStreamOutcome(stream, gen, 'continueRunStream');

          // Merge previously emitted command IDs with newly emitted ones
          // This prevents duplicates when result.history contains commands from the initial stream
          const allEmittedIds = new Set([...previouslyEmittedIds, ...acc.emittedCommandIds]);

          const resolvedResult = yield* this.#buildAndResolve(
            stream,
            acc.finalOutput || undefined,
            acc.reasoningOutput || undefined,
            allEmittedIds,
            acc.latestUsage,
          );

          if (resolvedResult.type === 'approval_required') {
            if (resolvedResult.approval.callId) {
              this.toolTracker.recordFunctionCall({
                type: 'function_call',
                callId: resolvedResult.approval.callId,
                name: resolvedResult.approval.toolName,
                arguments: resolvedResult.approval.argumentsText,
              });
            }
            this.logger.debug('Tool approval required', {
              eventType: 'approval.required',
              category: 'approval',
              phase: 'approval',
              sessionId: this.id,
              traceId: this.logger.getCorrelationId(),
              toolName: resolvedResult.approval.toolName,
            });
            this.#recordInputSurgeSuccess(this.conversationStore.getHistory(), {
              kind: this.retryOrchestrator.inputSurgeKindState,
              previousInput: previousInputForSurge,
            });
            yield toTerminalEvent(resolvedResult);
            return;
          }

          this.#recordInputSurgeSuccess(this.conversationStore.getHistory(), {
            kind: this.retryOrchestrator.inputSurgeKindState,
            previousInput: previousInputForSurge,
          });
          yield toTerminalEvent(resolvedResult);
          return;
        } catch (error) {
          const maxTransientRetries = getMaxTransientRetries({
            streamMaxRetries: getMethod<[], number | undefined>(this.agentClient, 'getStreamMaxRetries')?.call(
              this.agentClient,
            ),
          });
          const decision = this.retryOrchestrator.classifyForContinuation({
            error,
            transientRetryCount,
            stream,
            maxTransientRetries,
          });
          if (decision.kind !== 'transient') {
            throw error;
          }
          if (decision.kind === 'transient') {
            transientRetryCount = decision.attempt;
            this.logger.warn('Transient error in continuation, retrying', {
              eventType: 'retry.transient',
              category: 'retry',
              phase: 'retry',
              retryType: 'upstream',
              retryAttempt: transientRetryCount,
              maxRetries: maxTransientRetries,
              sessionId: this.id,
              traceId: this.logger.getCorrelationId(),
              errorMessage: error instanceof Error ? error.message : String(error),
              delayMs: decision.delay,
            });
            yield {
              type: 'retry',
              toolName: 'continuation',
              attempt: transientRetryCount,
              maxRetries: maxTransientRetries,
              errorMessage: error instanceof Error ? error.message : String(error),
              retryType: 'upstream',
            };
            await new Promise((resolve) => setTimeout(resolve, decision.delay));

            if (!this.retryOrchestrator.isCurrentGeneration(gen)) return;

            if (!stream) {
              this.#recoverApprovedToolResultsFromState(state, approvedToolResultCallIds);
              this.#commonRestoreForRetry(ledgerSnapshot, stream);

              const lastUserText = this.conversationStore.getLastUserMessage();
              const dummyTurn: UserTurn = { text: lastUserText };
              yield* this.run(dummyTurn, {
                skipUserMessage: true,
                retries: { transientRetryCount },
              });
              return;
            }

            // Rollback the tool ledger to the state right before this continuation started
            this.toolTracker.import(ledgerSnapshot);

            // Loop again to retry the continueRunStream call
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      this.logger.error('Conversation stream error during continuation', {
        eventType: 'stream.failed',
        category: 'stream',
        phase: 'abort',
        sessionId: this.id,
        traceId: this.logger.getCorrelationId(),
        errorMessage: describeError(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      yield {
        type: 'error',
        message: describeError(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      };
      throw error;
    } finally {
      // Clean up interceptor if one was added for rejection reason
      removeInterceptor();
    }
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

    for await (const event of this.continueAfterApproval({ answer: 'y' })) {
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
