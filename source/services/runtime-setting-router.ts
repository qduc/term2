import type { SettingsService } from './settings/settings-service.js';
import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import { setTrimConfig } from '../utils/output/output-trim.js';
import { planModeNotice } from './mode-notices.js';

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

export function applyRuntimeSettingChange(key: string, value: unknown, deps: RuntimeSettingRouterDeps): void {
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
    deps.setModel(deps.settingsService.get<string>('agent.model'));
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
    deps.setModel(deps.settingsService.get<string>('agent.model'));
    return;
  }

  if (key === 'app.mentorMode' || key === 'app.liteMode' || key === 'app.orchestratorMode') {
    deps.setModel(deps.settingsService.get<string>('agent.model'));
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
