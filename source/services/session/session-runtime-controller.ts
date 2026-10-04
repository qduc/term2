import type { ModelSelection } from '../settings/model-selection.js';
import type { ReasoningEffortSetting } from '../../contracts/conversation.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import { getMethod } from '../interruption-info.js';
import type { SessionLifecycle } from './session-lifecycle.js';

/**
 * Manages runtime settings that affect the agent client's behavior:
 * model, reasoning effort, temperature, provider, and retry callback.
 *
 * Each setting mutation calls `afterProviderChanged()` on the state controller
 * before delegating to the agent client when the client supports the mutation,
 * ensuring session state is properly reset (e.g., response chaining is severed).
 */
export class SessionRuntimeController {
  readonly #agentClient: ConversationAgentClient;
  readonly #state: SessionLifecycle;

  constructor(deps: { agentClient: ConversationAgentClient; state: SessionLifecycle }) {
    this.#agentClient = deps.agentClient;
    this.#state = deps.state;
  }

  setModelSelection(selection: ModelSelection): void {
    this.#state.afterProviderChanged();
    this.#agentClient.setModelSelection(selection);
  }

  setReasoningEffort(effort: ReasoningEffortSetting): void {
    const setReasoningEffort = getMethod<[ReasoningEffortSetting], void>(this.#agentClient, 'setReasoningEffort');
    if (!setReasoningEffort) {
      return;
    }
    this.#state.afterProviderChanged();
    setReasoningEffort.call(this.#agentClient, effort);
  }

  setTemperature(temperature?: number): void {
    const setTemperature = getMethod<[number | undefined], void>(this.#agentClient, 'setTemperature');
    if (!setTemperature) {
      return;
    }
    this.#state.afterProviderChanged();
    setTemperature.call(this.#agentClient, temperature);
  }

  setRetryCallback(callback: () => void): void {
    if (typeof this.#agentClient.setRetryCallback === 'function') {
      this.#agentClient.setRetryCallback(callback);
    }
  }
}
