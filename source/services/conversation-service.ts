import type { OpenAIAgentClient } from '../lib/openai-agent-client.js';
import type { ILoggingService, ISettingsService } from './service-interfaces.js';
import { ConversationSession } from './conversation-session.js';
import type { ConversationTerminal, ReasoningEffortSetting } from '../contracts/conversation.js';
import type { SavedToolExecution } from './tool-execution-ledger.js';
import type { LogEvent, StateSnapshot } from './conversation-log-events.js';

export type { ConversationTerminal, ApprovalDescriptor, PendingApproval } from '../contracts/conversation.js';
export type { CommandMessage } from './conversation-session.js';

/**
 * Backward-compatible facade for the CLI.
 *
 * Phase 3: the session owns the conversation state; the service is a thin wrapper.
 */
export class ConversationService {
  #session: ConversationSession;
  readonly #agentClient: OpenAIAgentClient;
  readonly #deps: { logger: ILoggingService; settingsService?: ISettingsService };

  constructor({
    agentClient,
    deps,
    sessionId = 'default',
    sessionStartedAt,
  }: {
    agentClient: OpenAIAgentClient;
    deps: { logger: ILoggingService; settingsService?: ISettingsService };
    sessionId?: string;
    sessionStartedAt?: string;
  }) {
    this.#agentClient = agentClient;
    this.#deps = deps;
    this.#session = new ConversationSession(sessionId, { agentClient, deps, sessionStartedAt });
  }

  get sessionId(): string {
    return this.#session.id;
  }

  resetWithNewId(newId: string): void {
    const previousLogSink = this.#logSink;
    this.#session.reset();
    this.#session = new ConversationSession(newId, {
      agentClient: this.#agentClient,
      deps: this.#deps,
    });
    if (previousLogSink) {
      this.#session.setLogSink(previousLogSink);
    }
  }

  #logSink: ((event: LogEvent) => void) | null = null;

  setLogSink(sink: ((event: LogEvent) => void) | null): void {
    this.#logSink = sink;
    this.#session.setLogSink(sink);
  }

  getCurrentSnapshot(): StateSnapshot {
    return this.#session.getCurrentSnapshot();
  }

  undoLastUserTurn(): { text: string; imageCount: number } | null {
    return this.#session.undoLastUserTurn();
  }

  listUserTurns(): { index: number; text: string; imageCount: number }[] {
    return this.#session.listUserTurns();
  }

  undoNUserTurns(n: number): { text: string; imageCount: number } | null {
    return this.#session.undoNUserTurns(n);
  }

  setModel(model: string): void {
    this.#session.setModel(model);
  }

  setReasoningEffort(effort: ReasoningEffortSetting): void {
    this.#session.setReasoningEffort(effort);
  }

  setTemperature(temperature?: number): void {
    this.#session.setTemperature(temperature);
  }

  setProvider(provider: string): void {
    this.#session.setProvider(provider);
  }

  switchProvider(provider: string): void {
    this.#session.switchProvider(provider);
  }

  setRetryCallback(callback: () => void): void {
    this.#session.setRetryCallback(callback);
  }

  addShellContext(historyText: string): void {
    this.#session.addShellContext(historyText);
  }

  queueModeNotice(text: string): void {
    this.#session.queueModeNotice(text);
  }

  abort(): void {
    this.#session.abort();
  }

  sendMessage(...args: Parameters<ConversationSession['sendMessage']>): Promise<ConversationTerminal> {
    return this.#session.sendMessage(...args);
  }

  previewLargeUncachedInput(
    ...args: Parameters<ConversationSession['previewLargeUncachedInput']>
  ): ReturnType<ConversationSession['previewLargeUncachedInput']> {
    return this.#session.previewLargeUncachedInput(...args);
  }

  handleApprovalDecision(
    ...args: Parameters<ConversationSession['handleApprovalDecision']>
  ): Promise<ConversationTerminal | null> {
    return this.#session.handleApprovalDecision(...args);
  }

  exportState(): {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger: SavedToolExecution[];
  } {
    return this.#session.exportState();
  }

  importState(state: {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger?: SavedToolExecution[];
    updatedAt?: string;
  }): void {
    this.#session.importState(state);
  }
}
