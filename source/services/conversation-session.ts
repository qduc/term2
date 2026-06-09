import type { ILoggingService, ISessionContextService, ISettingsService } from './service-interfaces.js';
import { ConversationStore } from './conversation-store.js';

import { SessionRetryOrchestrator, type RetryState } from './session-retry-orchestrator.js';
import type { ConversationEvent } from './conversation-events.js';
import type { CommandMessage } from '../tools/types.js';
import { type NormalizedUsage } from '../utils/token-usage.js';
import { ApprovalState } from './approval-state.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import type { ConversationTerminal, ReasoningEffortSetting } from '../contracts/conversation.js';
import { getCallIdFromObject } from './interruption-info.js';
import { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import type { AgentStream } from './agent-stream.js';
// stream-snapshot imports removed as they are now used in SessionStreamProcessor
import type { UserTurn } from '../types/user-turn.js';
import { type LargeUncachedInputDecision } from './large-uncached-input-guard.js';
// input-surge-guard import removed as it is now used in SessionStreamProcessor
import { SessionToolTracker } from './session-tool-tracker.js';
import { type SavedToolExecution } from './tool-execution-ledger.js';
import type { LogEvent, StateSnapshot } from './conversation-log-events.js';
import { ConversationLogger } from './conversation-logger.js';
import type { ConversationAgentClient } from './conversation-agent-client.js';
import { SessionInputPlanner } from './session-input-planner.js';
import { SessionStateController } from './session-state-controller.js';
import { ApprovalContinuationRunner } from './approval-continuation-runner.js';
import { ConversationTurnRunner } from './conversation-turn-runner.js';
import { SessionStateFacade } from './session-state-facade.js';
import {
  createConversationSessionComposition,
  type ConversationSessionRetryOptions,
} from './conversation-session-composition.js';
import { ConversationTerminalAdapter } from './conversation-terminal-adapter.js';
import { SessionRuntimeController } from './session-runtime-controller.js';
import { AutoApprovalContinuationResolver } from './auto-approval-continuation-resolver.js';

export type { CommandMessage };
export type ConversationResult = ConversationTerminal;

// StreamHistorySource removed

export type { ConversationSessionRetryOptions };

// stream-history replayed tools warning has been extracted to SessionStreamProcessor

export class ConversationSession {
  public readonly id: string;
  public readonly startedAt: string;
  private agentClient: ConversationAgentClient;
  private logger: ILoggingService;
  private conversationStore: ConversationStore;
  /* @internal — exposed for test access */
  approvalState: ApprovalState;
  private toolTracker: SessionToolTracker;
  private shellAutoApproval: ShellAutoApprovalResolver;
  private approvalFlow: ApprovalFlowCoordinator;
  private retryOrchestrator: SessionRetryOrchestrator;
  #inputPlanner: SessionInputPlanner;
  #state: SessionStateController;
  #continuationRunner: ApprovalContinuationRunner;
  #turnRunner: ConversationTurnRunner;
  #terminalAdapter: ConversationTerminalAdapter;
  #runtimeController: SessionRuntimeController;
  #stateFacade: SessionStateFacade;

  #autoApprovalResolver: AutoApprovalContinuationResolver;

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

  // finalizeStreamOutcome has been extracted to SessionStreamProcessor

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

    const composition = createConversationSessionComposition({
      sessionId: id,
      agentClient,
      deps,
      retryOptions: retryOptions ?? {},
      turnAccumulator: this.turnAccumulator,
      callbacks: {
        breakChaining: () => this.#breakChaining(),
        buildAndResolve: (result, finalOutputOverride, reasoningOutputOverride, emittedCommandIds, usage) =>
          this.#buildAndResolve(result, finalOutputOverride, reasoningOutputOverride, emittedCommandIds, usage),
        restartTurn: (turn, options) => this.run(turn, { ...options }),
        isCurrentGeneration: (gen) => this.#isCurrentGeneration(gen),
      },
    });

    this.conversationStore = composition.conversationStore;
    this.approvalState = composition.approvalState;
    this.toolTracker = composition.toolTracker;
    this.retryOrchestrator = composition.retryOrchestrator;
    this.shellAutoApproval = composition.shellAutoApproval;
    this.#inputPlanner = composition.inputPlanner;
    this.#state = composition.state;
    this.conversationLogger = composition.conversationLogger;
    this.approvalFlow = composition.approvalFlow;
    this.#continuationRunner = composition.continuationRunner;
    this.#turnRunner = composition.turnRunner;

    this.#autoApprovalResolver = new AutoApprovalContinuationResolver({
      approvalFlow: this.approvalFlow,
      shellAutoApproval: () => this.shellAutoApproval,
      logger: this.logger,
      sessionId: this.id,
      toolTracker: this.toolTracker,
      turnAccumulator: this.turnAccumulator,
      continuationRunner: this.#continuationRunner,
      retryOrchestrator: this.retryOrchestrator,
    });

    this.#terminalAdapter = new ConversationTerminalAdapter({
      sessionId: this.id,
      startedAt: this.startedAt,
      agentClient: this.agentClient,
      logger: this.logger,
      settingsService: this.settingsService,
      sessionContextService: this.sessionContextService,
      conversationStore: this.conversationStore,
      conversationLogger: this.conversationLogger,
      approvalFlow: this.approvalFlow,
      run: (input, options) => this.run(input, { ...options }),
      continueAfterApproval: (opts) => this.continueAfterApproval(opts),
    });

    this.#runtimeController = new SessionRuntimeController({
      agentClient: this.agentClient,
      state: this.#state,
    });

    this.#stateFacade = new SessionStateFacade({
      conversationStore: this.conversationStore,
      toolTracker: this.toolTracker,
      state: this.#state,
      conversationLogger: this.conversationLogger,
      agentClient: this.agentClient,
      settingsService: this.settingsService,
    });

    // When the WS transport degrades to HTTP for a provider that requires
    // WS for conversation chaining, sever the chain and switch to full-history
    // mode for the rest of the session.
    if (typeof this.agentClient.onDowngrade === 'function') {
      this.agentClient.onDowngrade(() => this.#breakChaining());
    }
  }

  /** @internal Compatibility delegate; owned by SessionInputPlanner. */
  previewLargeUncachedInput(input: string | UserTurn, now = Date.now()): LargeUncachedInputDecision {
    return this.#inputPlanner.previewLargeUncachedInput(input, now, {
      pendingModeNotice: this.#state.pendingModeNotice,
    });
  }

  #isCurrentGeneration(gen: number): boolean {
    return this.retryOrchestrator.isCurrentGeneration(gen);
  }

  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  reset(): void {
    this.#stateFacade.reset();
  }

  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  undoLastUserTurn(): { text: string; images?: UserTurn['images'] } | null {
    return this.#stateFacade.undoLastUserTurn();
  }

  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  listUserTurns(): { index: number; text: string; imageCount: number }[] {
    return this.#stateFacade.listUserTurns();
  }

  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  undoNUserTurns(n: number): { text: string; images?: UserTurn['images'] } | null {
    return this.#stateFacade.undoNUserTurns(n);
  }

  /** @internal Compatibility delegate; owned by SessionRuntimeController. */
  setModel(model: string): void {
    this.#runtimeController.setModel(model);
  }

  /** @internal Compatibility delegate; owned by SessionRuntimeController. */
  setReasoningEffort(effort: ReasoningEffortSetting): void {
    this.#runtimeController.setReasoningEffort(effort);
  }

  /** @internal Compatibility delegate; owned by SessionRuntimeController. */
  setTemperature(temperature?: number): void {
    this.#runtimeController.setTemperature(temperature);
  }

  /** @internal Compatibility delegate; owned by SessionRuntimeController. */
  setProvider(provider: string): void {
    this.#runtimeController.setProvider(provider);
  }

  /** Alias for setProvider, kept for public API surface. */
  /** @internal Compatibility delegate; owned by SessionRuntimeController. */
  switchProvider(provider: string): void {
    this.#runtimeController.switchProvider(provider);
  }

  /** @internal Compatibility delegate; owned by SessionRuntimeController. */
  setRetryCallback(callback: () => void): void {
    this.#runtimeController.setRetryCallback(callback);
  }

  setLogSink(sink: ((event: LogEvent) => void) | null): void {
    this.conversationLogger.setLogSink(sink);
  }

  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  getCurrentSnapshot(): StateSnapshot {
    return this.#stateFacade.getCurrentSnapshot();
  }

  // dedupeToolStarted has been extracted to SessionStreamProcessor

  /** @internal Used in tests to seed the input surge guard baseline. Owned by SessionInputPlanner. */
  __testSeedInputSurgeBaseline(data: unknown[], kind: 'delta' | 'full_history'): void {
    this.#inputPlanner.recordSuccess(data, { kind, previousInput: undefined });
  }

  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  exportState(): {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger: SavedToolExecution[];
  } {
    return this.#stateFacade.exportState();
  }

  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  importState(state: {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger?: SavedToolExecution[];
    updatedAt?: string;
  }): void {
    this.#stateFacade.importState(state);
  }

  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  addShellContext(historyText: string): void {
    this.#stateFacade.addShellContext(historyText);
  }
  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  queueModeNotice(text: string): void {
    this.#stateFacade.queueModeNotice(text);
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

  /** @internal Compatibility delegate; owned by ConversationTerminalAdapter. */
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
    return this.#terminalAdapter.sendMessage(input, {
      onTextChunk,
      onReasoningChunk,
      onCommandMessage,
      onEvent,
      hallucinationRetryCount,
    });
  }

  /** @internal Compatibility delegate; owned by ConversationTerminalAdapter. */
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
    return this.#terminalAdapter.handleApprovalDecision(answer, rejectionReason, {
      onTextChunk,
      onReasoningChunk,
      onCommandMessage,
      onEvent,
      approvalAnswer,
    });
  }

  async *#buildAndResolve(
    result: AgentStream,
    finalOutputOverride: string | undefined,
    reasoningOutputOverride: string | undefined,
    emittedCommandIds: Set<string> | undefined,
    usage: NormalizedUsage | undefined,
  ): AsyncGenerator<ConversationEvent, ConversationResult, void> {
    return yield* this.#autoApprovalResolver.buildAndResolve(
      result,
      finalOutputOverride,
      reasoningOutputOverride,
      emittedCommandIds,
      usage,
    );
  }
}
