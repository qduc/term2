import type { Agent, Runner } from '@openai/agents';
import { ConversationStore } from '../conversation-store.js';

/**
 * General-purpose subagent session. Replaces the private MentorSession shape.
 *
 * For persistent sessions (e.g. mentor): reuse across calls, track store and previousResponseId.
 * For one-shot runs (e.g. run_subagent): create a new session per call, discard after.
 */
export class SubagentSession {
  readonly id: string;
  readonly role: string;
  #provider: string | null = null;
  #runner: Runner | null = null;
  #agent: Agent | null = null;
  #store: ConversationStore | null = null;
  #previousResponseId: string | null = null;

  constructor(id: string, role: string) {
    this.id = id;
    this.role = role;
  }

  get provider(): string | null {
    return this.#provider;
  }

  get runner(): Runner | null {
    return this.#runner;
  }

  get agent(): Agent | null {
    return this.#agent;
  }

  get previousResponseId(): string | null {
    return this.#previousResponseId;
  }

  reset(): void {
    if (this.#store) {
      this.#store.clear();
    }
    this.#previousResponseId = null;
    this.#store = null;
    this.#runner = null;
    this.#provider = null;
    this.#agent = null;
  }

  switchProvider(provider: string): void {
    if (this.#provider !== provider) {
      this.#agent = null;
      this.#store = null;
      this.#previousResponseId = null;
      this.#runner = null;
      this.#provider = provider;
    }
  }

  ensureRunner(provider: string, createRunner: (providerId: string) => Runner | null): Runner | null {
    if (!this.#runner && provider !== 'openai') {
      this.#runner = createRunner(provider);
    }
    return this.#runner;
  }

  ensureAgent(createAgent: () => Agent): Agent {
    if (!this.#agent) {
      this.#agent = createAgent();
      this.#store = new ConversationStore();
    }
    return this.#agent;
  }

  addUserMessage(message: string): void {
    this.#store!.addUserMessage(message);
  }

  getInput(task: string, supportsConversationChaining: boolean): any {
    return supportsConversationChaining ? task : this.#store!.getHistory();
  }

  getRunOptions(supportsConversationChaining: boolean, maxTurns: number): Record<string, any> {
    return {
      stream: false,
      maxTurns,
      ...(supportsConversationChaining && this.#previousResponseId
        ? { previousResponseId: this.#previousResponseId }
        : {}),
    };
  }

  appendOutput(result: any): void {
    this.#store!.appendOutput(result.output);
    if (result.responseId) {
      this.#previousResponseId = result.responseId;
    }
  }
}
