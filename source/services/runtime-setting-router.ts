import type { SettingsService } from './settings/settings-service.js';
import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import { setTrimConfig } from '../utils/output/output-trim.js';
import { planModeNotice, runtimeModeNotice } from './mode-notices.js';
import { ProfileTransitionService } from './profiles/profile-transition.js';

export interface RuntimeSettingRouterConversationService {
  switchProvider(provider: string): void;
  queueModeNotice(text: string): void;
}

export interface RuntimeSettingRouterDeps {
  conversationService: RuntimeSettingRouterConversationService;
  settingsService: SettingsService;
  setModel: (model: string) => void;
  setReasoningEffort: (effort: ReasoningEffortSetting) => void;
  setTemperature: (temp: number | undefined) => void;
}

export type ConversationSettingChange = Readonly<{
  key: string;
  value: unknown;
  persistence: 'runtime' | 'restart';
}>;

/**
 * Owns the application effects of conversation-related settings. Menu code
 * only translates input into changes; this service applies the effective
 * settings transaction and then updates the live conversation/runtime.
 */
export class ConversationConfigurationService {
  readonly #deps: RuntimeSettingRouterDeps;

  constructor(deps: RuntimeSettingRouterDeps) {
    this.#deps = deps;
  }

  apply(changes: readonly ConversationSettingChange[]): { restartOnly: readonly string[] } {
    const runtime = changes.filter((change) => change.persistence === 'runtime');
    if (runtime.length > 0) {
      const planWas = Boolean(this.#deps.settingsService.get('app.planMode'));
      this.#deps.settingsService.setDynamicTransaction(runtime.map(({ key, value }) => ({ key, value })));
      for (const change of runtime) {
        this.applyRuntimeSetting(change.key, change.value);
      }
      const planIs = Boolean(this.#deps.settingsService.get('app.planMode'));
      const planKeyExplicit = runtime.some((change) => change.key === 'app.planMode');
      if (!planKeyExplicit && planWas !== planIs) {
        this.#deps.conversationService.queueModeNotice(planModeNotice(planIs));
      }
    }
    for (const change of changes.filter((item) => item.persistence === 'restart')) {
      this.#deps.settingsService.setPersistentDynamic(change.key, change.value);
    }
    return { restartOnly: changes.filter((change) => change.persistence === 'restart').map((change) => change.key) };
  }

  reset(key: string): void {
    this.#deps.settingsService.reset(key);
    if (this.#deps.settingsService.isRuntimeModifiable(key)) {
      this.applyRuntimeSetting(key, this.#deps.settingsService.getDynamic(key));
    }
  }

  applyRuntimeSetting(key: string, value: unknown): void {
    applyRuntimeSettingChange(key, value, this.#deps);
  }
}

export function applyRuntimeSettingChange(key: string, value: unknown, deps: RuntimeSettingRouterDeps): void {
  if (key === 'app.activeProfileId') {
    const transitionService = new ProfileTransitionService({
      settingsService: deps.settingsService,
      rebuildAgent: () => deps.setModel(deps.settingsService.get('agent.model')),
      queueModeNotice: (text) => deps.conversationService.queueModeNotice(text),
    });
    transitionService.activate(String(value));
    return;
  }

  if (key === 'agent.model') {
    deps.setModel(String(value));
    return;
  }

  if (key === 'agent.reasoningEffort') {
    deps.setReasoningEffort(value as ReasoningEffortSetting);
    return;
  }

  if (key === 'agent.temperature') {
    if (value == null) {
      deps.setTemperature(undefined);
      return;
    }

    const numeric = typeof value === 'number' ? value : Number(value);
    deps.setTemperature(Number.isFinite(numeric) ? numeric : undefined);
    return;
  }

  if (key === 'agent.provider') {
    deps.conversationService.switchProvider(String(value));
    return;
  }

  if (key === 'agent.transport') {
    deps.setModel(deps.settingsService.get('agent.model'));
    return;
  }

  if (
    key === 'agent.smartModel' ||
    key === 'agent.smartProvider' ||
    key === 'agent.balancedModel' ||
    key === 'agent.balancedProvider' ||
    key === 'agent.cheapModel' ||
    key === 'agent.cheapProvider' ||
    key === 'agent.choreModel' ||
    key === 'agent.choreProvider' ||
    key === 'agent.mentorModel' ||
    key === 'agent.mentorProvider' ||
    key === 'agent.mentorReasoningEffort'
  ) {
    deps.setModel(deps.settingsService.get('agent.model'));
    return;
  }

  if (key === 'app.mentorMode' || key === 'app.orchestratorMode') {
    deps.setModel(deps.settingsService.get('agent.model'));
    deps.conversationService.queueModeNotice(
      runtimeModeNotice(key === 'app.mentorMode' ? 'mentor' : 'orchestrator', Boolean(value)),
    );
    return;
  }

  if (key === 'app.liteMode') {
    deps.setModel(deps.settingsService.get('agent.model'));
    return;
  }

  if (key === 'app.planMode') {
    deps.conversationService.queueModeNotice(planModeNotice(Boolean(value)));
    return;
  }

  if (key === 'shell.autoApproveMode') {
    return;
  }

  if (key === 'shell.maxOutputLines') {
    setTrimConfig({ maxLines: Number(value) });
    return;
  }

  if (key === 'shell.maxOutputChars') {
    setTrimConfig({ maxCharacters: Number(value) });
  }
}
