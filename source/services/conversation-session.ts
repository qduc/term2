import { type RunState } from '@openai/agents';
import type { ILoggingService, ISessionContextService, ISettingsService } from './service-interfaces.js';

import { type RetryState } from './session-retry-orchestrator.js';
import type { ConversationEvent } from './conversation-events.js';
import type { CommandMessage } from '../tools/types.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import type { ConversationTerminal, ReasoningEffortSetting } from '../contracts/conversation.js';
import type { UserTurn } from '../types/user-turn.js';
import { type LargeUncachedInputDecision } from './large-uncached-input-guard.js';
import { type SavedToolExecution } from './tool-execution-ledger.js';
import type { LogEvent, StateSnapshot } from './conversation-log-events.js';
import type { ConversationAgentClient } from './conversation-agent-client.js';
import { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import {
  createConversationSessionComposition,
  type ConversationSessionComposition,
  type ConversationSessionRetryOptions,
} from './conversation-session-composition.js';

export type { CommandMessage };
export type ConversationResult = ConversationTerminal;

// StreamHistorySource removed

export type { ConversationSessionRetryOptions };

// stream-history replayed tools warning has been extracted to SessionStreamProcessor

/**
 * Options for the legacy constructor form (used in tests and by non-factory
 * callers that have not yet migrated to createConversationSession).
 */
type LegacyConstructorOptions = {
  agentClient: ConversationAgentClient;
  deps: {
    logger: ILoggingService;
    settingsService?: ISettingsService;
    sessionContextService: ISessionContextService;
  };
  sessionStartedAt?: string;
  retryOptions?: ConversationSessionRetryOptions;
};

/** Options for the composition-injection form used by the production factory. */
type CompositionConstructorOptions = {
  startedAt: string;
  composition: ConversationSessionComposition;
};

export class ConversationSession {
  public readonly id: string;
  public readonly startedAt: string;

  readonly #composition: ConversationSessionComposition;

  constructor(id: string, options: LegacyConstructorOptions | CompositionConstructorOptions) {
    this.id = id;

    if ('composition' in options) {
      // Production path: factory already built the composition.
      this.startedAt = options.startedAt;
      this.#composition = options.composition;
    } else {
      // Legacy path: build the composition internally (tests and transitional callers).
      const { agentClient, deps, sessionStartedAt, retryOptions } = options;
      this.startedAt = sessionStartedAt ?? new Date().toISOString();
      const turnAccumulator = new TurnItemAccumulator();
      this.#composition = createConversationSessionComposition({
        sessionId: id,
        sessionStartedAt: this.startedAt,
        agentClient,
        deps,
        retryOptions,
        turnAccumulator,
      });
    }
  }

  /* @internal — exposed for test access */
  get approvalState() {
    return this.#composition.approvalState;
  }

  /* @internal — exposed for test access */
  get shellAutoApproval(): ShellAutoApprovalResolver {
    return this.#composition.shellAutoApproval;
  }
  set shellAutoApproval(value: ShellAutoApprovalResolver) {
    (this.#composition.shellAutoApproval as any).setDelegate(value);
  }

  /* @internal — exposed for test access */
  get toolTracker() {
    return this.#composition.toolTracker;
  }

  /** @internal Compatibility delegate; owned by SessionInputPlanner. */
  previewLargeUncachedInput(input: string | UserTurn, now = Date.now()): LargeUncachedInputDecision {
    return this.#composition.inputPlanner.previewLargeUncachedInput(input, now, {
      pendingModeNotice: this.#composition.state.pendingModeNotice,
    });
  }

  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  reset(): void {
    this.#composition.stateFacade.reset();
  }

  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  undoLastUserTurn(): { text: string; images?: UserTurn['images'] } | null {
    return this.#composition.stateFacade.undoLastUserTurn();
  }

  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  listUserTurns(): { index: number; text: string; imageCount: number }[] {
    return this.#composition.stateFacade.listUserTurns();
  }

  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  undoNUserTurns(n: number): { text: string; images?: UserTurn['images'] } | null {
    return this.#composition.stateFacade.undoNUserTurns(n);
  }

  /** @internal Compatibility delegate; owned by SessionRuntimeController. */
  setModel(model: string): void {
    this.#composition.runtimeController.setModel(model);
  }

  /** @internal Compatibility delegate; owned by SessionRuntimeController. */
  setReasoningEffort(effort: ReasoningEffortSetting): void {
    this.#composition.runtimeController.setReasoningEffort(effort);
  }

  /** @internal Compatibility delegate; owned by SessionRuntimeController. */
  setTemperature(temperature?: number): void {
    this.#composition.runtimeController.setTemperature(temperature);
  }

  /** @internal Compatibility delegate; owned by SessionRuntimeController. */
  setProvider(provider: string): void {
    this.#composition.runtimeController.setProvider(provider);
  }

  /** Alias for setProvider, kept for public API surface. */
  /** @internal Compatibility delegate; owned by SessionRuntimeController. */
  switchProvider(provider: string): void {
    this.#composition.runtimeController.switchProvider(provider);
  }

  /** @internal Compatibility delegate; owned by SessionRuntimeController. */
  setRetryCallback(callback: () => void): void {
    this.#composition.runtimeController.setRetryCallback(callback);
  }

  setLogSink(sink: ((event: LogEvent) => void) | null): void {
    this.#composition.conversationLogger.setLogSink(sink);
  }

  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  getCurrentSnapshot(): StateSnapshot {
    return this.#composition.stateFacade.getCurrentSnapshot();
  }

  // dedupeToolStarted has been extracted to SessionStreamProcessor

  /** @internal Used in tests to seed the input surge guard baseline. Owned by SessionInputPlanner. */
  __testSeedInputSurgeBaseline(data: unknown[], kind: 'delta' | 'full_history'): void {
    this.#composition.inputPlanner.recordSuccess(data, { kind, previousInput: undefined });
  }

  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  exportState(): {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger: SavedToolExecution[];
  } {
    return this.#composition.stateFacade.exportState();
  }

  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  importState(state: {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger?: SavedToolExecution[];
    updatedAt?: string;
  }): void {
    this.#composition.stateFacade.importState(state);
  }

  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  addShellContext(historyText: string): void {
    this.#composition.stateFacade.addShellContext(historyText);
  }

  /** @internal Compatibility delegate; owned by SessionStateFacade. */
  queueModeNotice(text: string): void {
    this.#composition.stateFacade.queueModeNotice(text);
  }

  abort(): void {
    this.#composition.turnCoordinator.abort();
  }

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
      resumeState?: RunState<any, any>;
    } = {},
  ): AsyncIterable<ConversationEvent> {
    yield* this.#composition.turnCoordinator.start(input, {
      skipUserMessage,
      retries,
      maxModelRetries,
      signal,
      resumeState,
    });
  }

  /**
   * Continue a session after an approval decision.
   * Delegates to the TurnCoordinator.
   */
  async *continueAfterApproval({
    answer,
    rejectionReason,
  }: {
    answer: string;
    rejectionReason?: string;
  }): AsyncIterable<ConversationEvent> {
    yield* this.#composition.turnCoordinator.continueAfterApproval({
      answer,
      rejectionReason,
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
    return this.#composition.terminalAdapter.sendMessage(input, {
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
    return this.#composition.terminalAdapter.handleApprovalDecision(answer, rejectionReason, {
      onTextChunk,
      onReasoningChunk,
      onCommandMessage,
      onEvent,
      approvalAnswer,
    });
  }
}
