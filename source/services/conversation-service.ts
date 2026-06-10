import type { ILoggingService, ISettingsService, ISessionContextService } from './service-interfaces.js';
import type { ConversationTerminal, ReasoningEffortSetting } from '../contracts/conversation.js';
import type { SavedToolExecution } from './tool-execution-ledger.js';
import type { LogEvent, StateSnapshot } from './conversation-log-events.js';
import type { UserTurn } from '../types/user-turn.js';
import type { ConversationAgentClient } from './conversation-agent-client.js';
import type { SendMessageOptions, HandleApprovalDecisionOptions } from './conversation-adapter.js';
import type { LargeUncachedInputDecision } from './large-uncached-input-guard.js';
import { createConversationSession, type ConversationSessionBundle } from './conversation-session-factory.js';

export type { ConversationTerminal, ApprovalDescriptor, PendingApproval } from '../contracts/conversation.js';
export type { CommandMessage } from '../tools/types.js';

/**
 * Backward-compatible facade for the CLI.
 *
 * Phase 3: the session owns the conversation state; the service is a thin wrapper.
 */
export class ConversationService {
  #bundle: ConversationSessionBundle;
  readonly #agentClient: ConversationAgentClient;
  readonly #deps: {
    logger: ILoggingService;
    settingsService?: ISettingsService;
    sessionContextService: ISessionContextService;
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
    };
    sessionId?: string;
    sessionStartedAt?: string;
  }) {
    this.#agentClient = agentClient;
    this.#deps = deps;
    this.#bundle = createConversationSession({ agentClient, deps, sessionId, sessionStartedAt });
  }

  get sessionId(): string {
    return this.#bundle.session.id;
  }

  resetWithNewId(newId: string): void {
    const previousLogSink = this.#logSink;
    this.#bundle.stateFacade.reset();
    this.#bundle.dispose();
    this.#bundle = createConversationSession({
      agentClient: this.#agentClient,
      deps: this.#deps,
      sessionId: newId,
    });
    if (previousLogSink) {
      this.#bundle.conversationLogger.setLogSink(previousLogSink);
    }
  }

  #logSink: ((event: LogEvent) => void) | null = null;

  setLogSink(sink: ((event: LogEvent) => void) | null): void {
    this.#logSink = sink;
    this.#bundle.conversationLogger.setLogSink(sink);
  }

  getCurrentSnapshot(): StateSnapshot {
    return this.#bundle.stateFacade.getCurrentSnapshot();
  }

  undoLastUserTurn(): { text: string; images?: UserTurn['images'] } | null {
    return this.#bundle.stateFacade.undoLastUserTurn();
  }

  listUserTurns(): { index: number; text: string; imageCount: number }[] {
    return this.#bundle.stateFacade.listUserTurns();
  }

  undoNUserTurns(n: number): { text: string; images?: UserTurn['images'] } | null {
    return this.#bundle.stateFacade.undoNUserTurns(n);
  }

  setModel(model: string): void {
    this.#bundle.runtimeController.setModel(model);
  }

  setReasoningEffort(effort: ReasoningEffortSetting): void {
    this.#bundle.runtimeController.setReasoningEffort(effort);
  }

  setTemperature(temperature?: number): void {
    this.#bundle.runtimeController.setTemperature(temperature);
  }

  setProvider(provider: string): void {
    this.#bundle.runtimeController.setProvider(provider);
  }

  switchProvider(provider: string): void {
    this.#bundle.runtimeController.switchProvider(provider);
  }

  setRetryCallback(callback: () => void): void {
    this.#bundle.runtimeController.setRetryCallback(callback);
  }

  addShellContext(historyText: string): void {
    this.#bundle.stateFacade.addShellContext(historyText);
  }

  queueModeNotice(text: string): void {
    this.#bundle.stateFacade.queueModeNotice(text);
  }

  abort(): void {
    this.#bundle.session.abort();
  }

  sendMessage(input: string | UserTurn, options?: SendMessageOptions): Promise<ConversationTerminal> {
    return this.#bundle.terminalAdapter.sendMessage(input, options);
  }

  previewLargeUncachedInput(input: string | UserTurn, now?: number): LargeUncachedInputDecision {
    return this.#bundle.stateFacade.previewLargeUncachedInput(input, now);
  }

  handleApprovalDecision(
    answer: string,
    rejectionReason?: string,
    options?: HandleApprovalDecisionOptions,
  ): Promise<ConversationTerminal | null> {
    return this.#bundle.terminalAdapter.handleApprovalDecision(answer, rejectionReason, options);
  }

  exportState(): {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger: SavedToolExecution[];
  } {
    return this.#bundle.stateFacade.exportState();
  }

  importState(state: {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger?: SavedToolExecution[];
    updatedAt?: string;
  }): void {
    this.#bundle.stateFacade.importState(state);
  }
}
