import { getMethod } from '../interruption-info.js';
/**
 * Manages runtime settings that affect the agent client's behavior:
 * model, reasoning effort, temperature, provider, and retry callback.
 *
 * Each setting mutation calls `afterProviderChanged()` on the state controller
 * before delegating to the agent client when the client supports the mutation,
 * ensuring session state is properly reset (e.g., response chaining is severed).
 */
export class SessionRuntimeController {
    #agentClient;
    #state;
    constructor(deps) {
        this.#agentClient = deps.agentClient;
        this.#state = deps.state;
    }
    setModelSelection(selection) {
        this.#state.afterProviderChanged();
        this.#agentClient.setModelSelection(selection);
    }
    setReasoningEffort(effort) {
        const setReasoningEffort = getMethod(this.#agentClient, 'setReasoningEffort');
        if (!setReasoningEffort) {
            return;
        }
        this.#state.afterProviderChanged();
        setReasoningEffort.call(this.#agentClient, effort);
    }
    setTemperature(temperature) {
        const setTemperature = getMethod(this.#agentClient, 'setTemperature');
        if (!setTemperature) {
            return;
        }
        this.#state.afterProviderChanged();
        setTemperature.call(this.#agentClient, temperature);
    }
    setRetryCallback(callback) {
        if (typeof this.#agentClient.setRetryCallback === 'function') {
            this.#agentClient.setRetryCallback(callback);
        }
    }
}
//# sourceMappingURL=session-runtime-controller.js.map