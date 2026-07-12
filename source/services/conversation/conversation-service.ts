import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ConversationTerminal, ReasoningEffortSetting } from '../../contracts/conversation.js';
import type { SavedToolExecution } from '../tool-execution-ledger.js';
import type { LogEvent, StateSnapshot } from '../logging/conversation-log-events.js';
import type { UserTurn } from '../../types/user-turn.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { SkillsService } from '../skills/skills-service.js';
import type {
  SendMessageOptions,
  HandleApprovalDecisionOptions,
  ConversationAdapter,
  ConversationEventSink,
} from './conversation-adapter.js';
import type { LargeUncachedInputDecision } from '../large-uncached-input-guard.js';
import type { InputSurgeDecision } from '../input-surge-guard.js';
import type { SessionRuntime } from '../session/session-composition.js';
import type { QueueStateObserver } from './conversation-adapter.js';
import { createConversationRuntime } from './conversation-runtime-factory.js';

export type { ConversationTerminal, ApprovalDescriptor, PendingApproval } from '../../contracts/conversation.js';
export type { CommandMessage } from '../../tools/types.js';

/**
 * Backward-compatible facade for the CLI.
 *
 * Phase 3: the session owns the conversation state; the service is a thin wrapper.
 */
export class ConversationService {
  #runtime: SessionRuntime;
  #adapter: ConversationAdapter;
  readonly #agentClient: ConversationAgentClient;
  #eventSink: ConversationEventSink | null = null;
  readonly #deps: {
    logger: ILoggingService;
    settingsService?: ISettingsService;
    sessionContextService: ISessionContextService;
    skillsService?: SkillsService;
  };

  constructor({
    agentClient,
    deps,
    sessionId = 'default',
    sessionStartedAt,
  }: {
    agentClient: ConversationAgentClient;
    deps: {
      logger: ILoggingService;
      settingsService?: ISettingsService;
      sessionContextService: ISessionContextService;
      skillsService?: SkillsService;
    };
    sessionId?: string;
    sessionStartedAt?: string;
  }) {
    this.#agentClient = agentClient;
    this.#deps = deps;
    const { runtime, adapter } = createConversationRuntime({
      agentClient,
      deps,
      queueForeground: true,
      sessionId: sessionId ?? 'default',
      sessionStartedAt,
    });
    this.#runtime = runtime;
    this.#adapter = adapter;
  }

  setEventSink(sink: ConversationEventSink | null): void {
    this.#eventSink = sink;
    this.#adapter.setEventSink(sink);
  }

  get sessionId(): string {
    return this.#runtime.sessionId;
  }

  resetWithNewId(newId: string): void {
    const previousLogSink = this.#logSink;
    const previousEventSink = this.#eventSink;
    this.#runtime.state.reset();
    this.#runtime.dispose();
    this.#deps.skillsService?.discoverSkills();
    const { runtime, adapter } = createConversationRuntime({
      agentClient: this.#agentClient,
      deps: this.#deps,
      queueForeground: true,
      sessionId: newId,
    });
    this.#runtime = runtime;
    this.#adapter = adapter;
    if (previousLogSink) {
      this.#runtime.logs.setLogSink(previousLogSink);
    }
    if (previousEventSink) {
      this.#adapter.setEventSink(previousEventSink);
    }
  }

  #logSink: ((event: LogEvent) => void) | null = null;

  setLogSink(sink: ((event: LogEvent) => void) | null): void {
    this.#logSink = sink;
    this.#runtime.logs.setLogSink(sink);
  }

  getCurrentSnapshot(): StateSnapshot {
    return this.#runtime.state.getCurrentSnapshot();
  }

  undoLastUserTurn(): { text: string; images?: UserTurn['images'] } | null {
    return this.#runtime.state.undoLastUserTurn();
  }

  listUserTurns(): { index: number; text: string; imageCount: number }[] {
    return this.#runtime.state.listUserTurns();
  }

  undoNUserTurns(n: number): { text: string; images?: UserTurn['images'] } | null {
    return this.#runtime.state.undoNUserTurns(n);
  }

  peekLastToolOutput(): {
    index: number;
    callId?: string;
    toolName?: string;
    output?: unknown;
    itemType: string;
  } | null {
    return this.#runtime.state.peekLastToolOutput();
  }

  setModel(model: string): void {
    this.#runtime.settings.setModel(model);
  }

  setReasoningEffort(effort: ReasoningEffortSetting): void {
    this.#runtime.settings.setReasoningEffort(effort);
  }

  setTemperature(temperature?: number): void {
    this.#runtime.settings.setTemperature(temperature);
  }

  setProvider(provider: string): void {
    this.#runtime.settings.setProvider(provider);
  }

  switchProvider(provider: string): void {
    this.#runtime.settings.switchProvider(provider);
  }

  setRetryCallback(callback: () => void): void {
    this.#runtime.settings.setRetryCallback(callback);
  }

  addShellContext(historyText: string): void {
    this.#runtime.state.addShellContext(historyText);
  }

  queueModeNotice(text: string): void {
    this.#runtime.state.queueModeNotice(text);
  }

  abort(): void {
    this.#adapter.abort();
  }

  sendMessage(input: string | UserTurn, options?: SendMessageOptions): Promise<ConversationTerminal> {
    return this.#adapter.sendMessage(input, options);
  }

  /** Resume foreground messages retained after an execution failure or abort. */
  resumeQueue(): Promise<void> {
    return this.#adapter.resumeQueue();
  }

  /** Discard all queued foreground messages without executing them. */
  discardQueue(): Promise<void> {
    return this.#adapter.discardQueue();
  }

  /** Set an observer for queue state changes. The observer fires immediately with current state. */
  setQueueStateObserver(observer: QueueStateObserver | null): void {
    this.#adapter.setQueueStateObserver(observer);
  }

  retryLastToolOutput(options?: SendMessageOptions): Promise<ConversationTerminal | null> {
    this.abort();
    const removed = this.#runtime.state.retryLastToolOutput();
    if (removed === null) {
      return Promise.resolve(null);
    }

    return this.#adapter.sendMessage('', {
      ...options,
      replayFromHistory: true,
    });
  }

  previewLargeUncachedInput(input: string | UserTurn, now?: number): LargeUncachedInputDecision {
    return this.#runtime.state.previewLargeUncachedInput(input, now);
  }

  previewInputSurge(input: string | UserTurn): InputSurgeDecision {
    return this.#runtime.state.previewInputSurge(input);
  }

  handleApprovalDecision(
    answer: string,
    rejectionReason?: string,
    options?: HandleApprovalDecisionOptions,
  ): Promise<ConversationTerminal | null> {
    return this.#adapter.handleApprovalDecision(answer, rejectionReason, options);
  }

  exportState(): {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger: SavedToolExecution[];
  } {
    return this.#runtime.state.exportState();
  }

  importState(state: {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger?: SavedToolExecution[];
    updatedAt?: string;
  }): void {
    this.#runtime.state.importState(state);
  }
}
