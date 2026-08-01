import type { LegacyRunner } from '../../contracts/model.js';
import { ConversationStore } from '../conversation/conversation-store.js';
import type { SavedToolExecution } from '../tool-execution-ledger.js';
import type { ProviderInputItem } from '../../contracts/provider-input.js';

/**
 * General-purpose subagent session. Replaces the private MentorSession shape.
 *
 * For persistent sessions (e.g. mentor): reuse across calls, track store and previousResponseId.
 * For one-shot runs (e.g. run_subagent): create a new session per call, discard after.
 */
export type SubagentSessionState = {
  history: ProviderInputItem[];
  previousResponseId: string | null;
  toolLedger: SavedToolExecution[];
};

export class SubagentSession {
  readonly id: string;
  readonly role: string;
  #provider: string | null = null;
  #runner: LegacyRunner | null = null;
  #agent: unknown = null;
  #store: ConversationStore | null = null;
  #previousResponseId: string | null = null;
  #toolLedger: SavedToolExecution[] = [];

  constructor(id: string, role: string) {
    this.id = id;
    this.role = role;
  }

  get provider(): string | null {
    return this.#provider;
  }

  get runner(): LegacyRunner | null {
    return this.#runner;
  }

  get agent(): unknown {
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
    this.#toolLedger = [];
    this.#store = null;
    this.#runner = null;
    this.#provider = null;
    this.#agent = null;
  }

  exportState(): SubagentSessionState {
    return {
      history: this.#store?.getHistory() ?? [],
      previousResponseId: this.#previousResponseId,
      toolLedger: [...this.#toolLedger],
    };
  }

  importState(state: SubagentSessionState): void {
    this.#store?.clear();
    if (!this.#store) {
      this.#store = new ConversationStore();
    }
    for (const item of state.history ?? []) {
      this.#store.addImportedItem(item);
    }
    this.#previousResponseId = state.previousResponseId ?? null;
    this.#toolLedger = state.toolLedger ? [...state.toolLedger] : [];
  }

  getUserTurnCount(): number {
    return this.#store?.listUserTurns().length ?? 0;
  }

  trimHistory(maxUserTurns: number): void {
    this.#store?.trimUserTurns(maxUserTurns);
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

  ensureRunner(provider: string, createRunner: (providerId: string) => LegacyRunner | null): LegacyRunner | null {
    if (!this.#runner && provider !== 'openai') {
      this.#runner = createRunner(provider);
    }
    return this.#runner;
  }

  ensureAgent(createAgent: () => unknown): unknown {
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

  setToolLedger(toolLedger: SavedToolExecution[]): void {
    this.#toolLedger = [...toolLedger];
  }
}
