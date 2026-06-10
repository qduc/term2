import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import type { ConversationAgentClient } from './conversation-agent-client.js';
import { getMethod } from './interruption-info.js';
import type { SessionLifecycle } from './session-lifecycle.js';

/**
 * Manages runtime settings that affect the agent client's behavior:
 * model, reasoning effort, temperature, provider, and retry callback.
 *
 * Each setting mutation calls `afterProviderChanged()` on the state controller
 * before delegating to the agent client, ensuring session state is properly
 * reset (e.g., response chaining is severed).
 */
export class SessionRuntimeController {
  readonly #agentClient: ConversationAgentClient;
  readonly #state: SessionLifecycle;

  constructor(deps: { agentClient: ConversationAgentClient; state: SessionLifecycle }) {
    this.#agentClient = deps.agentClient;
    this.#state = deps.state;
  }

  setModel(model: string): void {
    this.#state.afterProviderChanged();
    this.#agentClient.setModel(model);
  }

  setReasoningEffort(effort: ReasoningEffortSetting): void {
    this.#state.afterProviderChanged();
    const setReasoningEffort = getMethod<[ReasoningEffortSetting], void>(this.#agentClient, 'setReasoningEffort');
    setReasoningEffort?.call(this.#agentClient, effort);
  }

  setTemperature(temperature?: number): void {
    this.#state.afterProviderChanged();
    const setTemperature = getMethod<[number | undefined], void>(this.#agentClient, 'setTemperature');
    setTemperature?.call(this.#agentClient, temperature);
  }

  setProvider(provider: string): void {
    this.#state.afterProviderChanged();
    const setProvider = getMethod<[string], void>(this.#agentClient, 'setProvider');
    setProvider?.call(this.#agentClient, provider);
  }

  /** Alias for setProvider, kept for public API surface. */
  switchProvider(provider: string): void {
    this.setProvider(provider);
  }

  setRetryCallback(callback: () => void): void {
    if (typeof this.#agentClient.setRetryCallback === 'function') {
      this.#agentClient.setRetryCallback(callback);
    }
  }
}
