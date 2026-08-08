import { parseInput } from '../../utils/input-parser.js';
import { parseModelProviderArg } from '../../utils/ai/model-provider-arg.js';
import type { SettingsService } from '../settings/settings-service.js';
import type { ConversationConfigurationService } from '../runtime-setting-router.js';
import {
  handoffFlowReducer,
  createInitialHandoffState,
  composeHandoffMessage,
  type HandoffAction,
  type HandoffState,
} from './handoff-flow-reducer.js';

export type HandoffSessionDeps = {
  clearConversationAndRefreshBanner: () => Promise<void>;
  addSystemMessage: (text: string) => void;
  sendUserMessage: (turn: { text: string }) => Promise<void>;
  settingsService: SettingsService;
  applyRuntimeSetting: (key: string, value: unknown) => void;
  setModel: (model: string) => void;
  configurationService?: ConversationConfigurationService;
};

/**
 * Owns handoff policy and effects. React/menu code remains responsible for
 * presenting this snapshot and for deciding when a controller frame closed.
 */
export class HandoffSession {
  #state: HandoffState | null = createInitialHandoffState();
  readonly #deps: HandoffSessionDeps;
  readonly #listeners = new Set<(state: HandoffState | null) => void>();

  constructor(deps: HandoffSessionDeps) {
    this.#deps = deps;
  }

  getState(): HandoffState | null {
    return this.#state;
  }

  subscribe(listener: (state: HandoffState | null) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  startHandoff(capturedText: string): void {
    this.#dispatch({ type: 'handoff/started', capturedText });
  }

  captureMessage(text: string): boolean {
    if (this.#state?.stage !== 'entering_message') return false;
    this.#dispatch({ type: 'handoff/message_captured', handoffMessage: text.trim() || 'Implement this' });
    return true;
  }

  async confirmHandoff(): Promise<boolean> {
    if (!this.#state) return false;
    await this.#deps.clearConversationAndRefreshBanner();
    this.#dispatch({ type: 'handoff/model_confirmed' });
    return true;
  }

  async declineHandoff(): Promise<boolean> {
    const state = this.#state;
    if (!state) return false;
    if (this.#deps.settingsService.get('app.planMode')) {
      await this.#deps.clearConversationAndRefreshBanner();
      this.#dispatch({ type: 'handoff/standard_mode_requested' });
      return true;
    }
    await this.#deps.clearConversationAndRefreshBanner();
    await this.#sendAndFinish(state);
    return true;
  }

  cancelHandoff(): boolean {
    if (!this.#state) return false;
    this.#dispatch({ type: 'handoff/cancelled' });
    this.#deps.addSystemMessage('Handoff cancelled');
    return true;
  }

  async sendCapturedHandoff(): Promise<boolean> {
    const state = this.#state;
    if (!state || (state.stage !== 'selecting_model' && state.stage !== 'selecting_effort')) return false;
    if (this.#deps.settingsService.get('app.planMode')) {
      this.#dispatch({ type: 'handoff/standard_mode_requested' });
      return true;
    }
    await this.#sendAndFinish(state);
    return true;
  }

  selectModel(text: string): boolean {
    if (!this.#state || this.#state.stage !== 'selecting_model') return false;
    const parsedInput = parseInput(text);
    const modelArg = parsedInput.type === 'slash-command' ? parsedInput.args : text;
    const { modelId, provider } = parseModelProviderArg(modelArg);
    if (modelId) {
      const changes = [{ key: 'agent.model', value: modelId, persistence: 'runtime' as const }];
      if (provider) changes.push({ key: 'agent.provider', value: provider, persistence: 'runtime' as const });
      if (this.#deps.configurationService) {
        this.#deps.configurationService.apply(changes);
      } else {
        this.#deps.settingsService.set('agent.model', modelId);
        if (provider) {
          this.#deps.settingsService.set('agent.provider', provider);
          this.#deps.applyRuntimeSetting('agent.provider', provider);
        }
        this.#deps.applyRuntimeSetting('agent.model', modelId);
        this.#deps.setModel(modelId);
      }
    }
    this.#dispatch({ type: 'handoff/model_selected' });
    return true;
  }

  async completeHandoffWithEffort(effort: string): Promise<boolean> {
    const state = this.#state;
    if (!state) return false;
    this.#applyRuntimeSetting('agent.reasoningEffort', effort);
    return this.#sendAndFinish(state);
  }

  async confirmStandardMode(): Promise<boolean> {
    const state = this.#state;
    if (!state) return false;
    this.#applyRuntimeSetting('app.planMode', false);
    this.#deps.addSystemMessage('Plan mode disabled - switched to Standard mode');
    return this.#sendAndFinish(state);
  }

  async declineStandardMode(): Promise<boolean> {
    const state = this.#state;
    if (!state) return false;
    return this.#sendAndFinish(state);
  }

  #dispatch(action: HandoffAction): void {
    this.#state = handoffFlowReducer(this.#state, action);
    for (const listener of this.#listeners) listener(this.#state);
  }

  async #sendAndFinish(state: HandoffState): Promise<boolean> {
    this.#dispatch({ type: 'handoff/sent' });
    if (state.capturedText) await this.#deps.sendUserMessage({ text: composeHandoffMessage(state) });
    return true;
  }

  #applyRuntimeSetting(key: string, value: unknown): void {
    if (this.#deps.configurationService) {
      this.#deps.configurationService.apply([{ key, value, persistence: 'runtime' }]);
      return;
    }
    this.#deps.settingsService.set(key as any, value as any);
    this.#deps.applyRuntimeSetting(key, value);
  }
}
