import { parseInput } from '../../utils/input-parser.js';
import { parseModelProviderArg } from '../../utils/ai/model-provider-arg.js';
import { resolveActiveEnforcement } from '../profiles/index.js';
import { ProfileTransitionService } from '../profiles/profile-transition.js';
import { handoffFlowReducer, createInitialHandoffState, composeHandoffMessage, } from './handoff-flow-reducer.js';
/**
 * Owns handoff policy and effects. React/menu code remains responsible for
 * presenting this snapshot and for deciding when a controller frame closed.
 */
export class HandoffSession {
    #state = createInitialHandoffState();
    #deps;
    #transitionService;
    #listeners = new Set();
    constructor(deps) {
        this.#deps = deps;
        this.#transitionService = new ProfileTransitionService({
            settingsService: deps.settingsService,
            rebuildAgent: () => deps.setModelSelection(deps.settingsService.get('agent.modelSelection')),
            queueModeNotice: deps.queueModeNotice,
        });
    }
    updateDeps(deps) {
        this.#deps = deps;
        this.#transitionService = new ProfileTransitionService({
            settingsService: deps.settingsService,
            rebuildAgent: () => deps.setModelSelection(deps.settingsService.get('agent.modelSelection')),
            queueModeNotice: deps.queueModeNotice,
        });
    }
    getState() {
        return this.#state;
    }
    subscribe(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    startHandoff(capturedText) {
        this.#dispatch({ type: 'handoff/started', capturedText });
    }
    captureMessage(text) {
        if (this.#state?.stage !== 'entering_message')
            return false;
        this.#dispatch({ type: 'handoff/message_captured', handoffMessage: text.trim() || 'Implement this' });
        return true;
    }
    async confirmHandoff() {
        if (!this.#state)
            return false;
        await this.#deps.clearConversationAndRefreshBanner();
        this.#dispatch({ type: 'handoff/model_confirmed' });
        return true;
    }
    async declineHandoff() {
        const state = this.#state;
        if (!state)
            return false;
        if (resolveActiveEnforcement(this.#deps.settingsService).handoffRestrictions.has('plan-read-only')) {
            await this.#deps.clearConversationAndRefreshBanner();
            this.#dispatch({ type: 'handoff/standard_mode_requested' });
            return true;
        }
        await this.#deps.clearConversationAndRefreshBanner();
        await this.#sendAndFinish(state);
        return true;
    }
    cancelHandoff() {
        if (!this.#state)
            return false;
        this.#dispatch({ type: 'handoff/cancelled' });
        this.#deps.addSystemMessage('Handoff cancelled');
        return true;
    }
    async sendCapturedHandoff() {
        const state = this.#state;
        if (!state || (state.stage !== 'selecting_model' && state.stage !== 'selecting_effort'))
            return false;
        if (resolveActiveEnforcement(this.#deps.settingsService).handoffRestrictions.has('plan-read-only')) {
            this.#dispatch({ type: 'handoff/standard_mode_requested' });
            return true;
        }
        await this.#sendAndFinish(state);
        return true;
    }
    selectModel(text) {
        if (!this.#state || this.#state.stage !== 'selecting_model')
            return false;
        const parsedInput = parseInput(text);
        const modelArg = parsedInput.type === 'slash-command' ? parsedInput.args : text;
        const { modelId, provider } = parseModelProviderArg(modelArg);
        if (modelId) {
            const selection = {
                model: modelId,
                provider: provider ?? this.#deps.settingsService.get('agent.modelSelection').provider,
            };
            const changes = [{ key: 'agent.modelSelection', value: selection, persistence: 'runtime' }];
            if (this.#deps.configurationService) {
                this.#deps.configurationService.apply(changes);
            }
            else {
                this.#deps.settingsService.set('agent.modelSelection', selection);
                this.#deps.applyRuntimeSetting('agent.modelSelection', selection);
                this.#deps.setModelSelection(selection);
            }
        }
        this.#dispatch({ type: 'handoff/model_selected' });
        return true;
    }
    async completeHandoffWithEffort(effort) {
        const state = this.#state;
        if (!state)
            return false;
        this.#applyRuntimeSetting('agent.reasoningEffort', effort);
        return this.#sendAndFinish(state);
    }
    async confirmStandardMode() {
        const state = this.#state;
        if (!state)
            return false;
        this.#transitionService.activate('builtin:standard');
        this.#deps.addSystemMessage('Plan mode disabled - switched to Standard mode');
        return this.#sendAndFinish(state);
    }
    async declineStandardMode() {
        const state = this.#state;
        if (!state)
            return false;
        return this.#sendAndFinish(state);
    }
    #dispatch(action) {
        this.#state = handoffFlowReducer(this.#state, action);
        for (const listener of this.#listeners)
            listener(this.#state);
    }
    async #sendAndFinish(state) {
        this.#dispatch({ type: 'handoff/sent' });
        if (state.capturedText)
            await this.#deps.sendUserMessage({ text: composeHandoffMessage(state) });
        return true;
    }
    #applyRuntimeSetting(key, value) {
        if (this.#deps.configurationService) {
            this.#deps.configurationService.apply([{ key, value, persistence: 'runtime' }]);
            return;
        }
        this.#deps.settingsService.set(key, value);
        this.#deps.applyRuntimeSetting(key, value);
    }
}
//# sourceMappingURL=handoff-session.js.map