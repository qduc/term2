import type {OpenAIAgentClient} from '../lib/openai-agent-client.js';
import type {ILoggingService} from './service-interfaces.js';
import {ConversationSession} from './conversation-session.js';

export type {ConversationResult, CommandMessage} from './conversation-session.js';

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
        deps: {logger: ILoggingService};
        sessionId?: string;
    }) {
        this.#session = new ConversationSession(sessionId, {agentClient, deps});
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

    setReasoningEffort(effort: any): void {
        this.#session.setReasoningEffort(effort);
    }

    setTemperature(temperature: any): void {
        (this.#session as any).setTemperature?.(temperature);
    }

    setProvider(provider: string): void {
        this.#session.setProvider(provider);
    }

    setRetryCallback(callback: () => void): void {
        this.#session.setRetryCallback(callback);
    }

    abort(): void {
        this.#session.abort();
    }

    sendMessage(...args: Parameters<ConversationSession['sendMessage']>) {
        return this.#session.sendMessage(...args);
    }

    handleApprovalDecision(...args: Parameters<ConversationSession['handleApprovalDecision']>) {
        return this.#session.handleApprovalDecision(...args);
    }
}
