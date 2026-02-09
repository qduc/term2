import type { OpenAIAgentClient } from '../lib/openai-agent-client.js';
import type { ILoggingService } from './service-interfaces.js';
import { ConversationSession } from './conversation-session.js';
import type { ConversationTerminal, ReasoningEffortSetting } from '../contracts/conversation.js';

export type { ConversationTerminal, ApprovalDescriptor, PendingApproval } from '../contracts/conversation.js';
export type { CommandMessage } from './conversation-session.js';

/**
 * Backward-compatible facade for the CLI.
 *
 * Phase 3: the session owns the conversation state; the service is a thin wrapper.
 */
export class ConversationService {
  readonly #session: ConversationSession;

  constructor({
    agentClient,
    deps,
    sessionId = 'default',
  }: {
    agentClient: OpenAIAgentClient;
    deps: { logger: ILoggingService };
    sessionId?: string;
  }) {
    this.#session = new ConversationSession(sessionId, { agentClient, deps });
  }

  get sessionId(): string {
    return this.#session.id;
  }

  reset(): void {
    this.#session.reset();
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

  setRetryCallback(callback: () => void): void {
    this.#session.setRetryCallback(callback);
  }

  addShellContext(historyText: string): void {
    this.#session.addShellContext(historyText);
  }

  abort(): void {
    this.#session.abort();
  }

  sendMessage(...args: Parameters<ConversationSession['sendMessage']>): Promise<ConversationTerminal> {
    return this.#session.sendMessage(...args);
  }

  handleApprovalDecision(
    ...args: Parameters<ConversationSession['handleApprovalDecision']>
  ): Promise<ConversationTerminal | null> {
    return this.#session.handleApprovalDecision(...args);
  }
}
