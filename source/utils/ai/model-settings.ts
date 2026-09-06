import { SETTING_KEYS } from '../../services/settings/settings-schema.js';

export type ModelSettingConfig = {
  modelKey: string;
  trigger: string;
  providerKey: string;
  fallbackProviderKey?: string;
};

export const MODEL_CMD_TRIGGER = '/model ';

export const MODEL_SETTING_CONFIGS: ModelSettingConfig[] = [
  {
    modelKey: SETTING_KEYS.AGENT_MODEL,
    trigger: '/settings agent.model ',
    providerKey: SETTING_KEYS.AGENT_PROVIDER,
  },
  {
    modelKey: SETTING_KEYS.AGENT_SMART_MODEL,
    trigger: '/settings agent.smartModel ',
    providerKey: SETTING_KEYS.AGENT_SMART_PROVIDER,
    fallbackProviderKey: SETTING_KEYS.AGENT_PROVIDER,
  },
  {
    modelKey: SETTING_KEYS.AGENT_BALANCED_MODEL,
    trigger: '/settings agent.balancedModel ',
    providerKey: SETTING_KEYS.AGENT_BALANCED_PROVIDER,
    fallbackProviderKey: SETTING_KEYS.AGENT_PROVIDER,
  },
  {
    modelKey: SETTING_KEYS.AGENT_CHEAP_MODEL,
    trigger: '/settings agent.cheapModel ',
    providerKey: SETTING_KEYS.AGENT_CHEAP_PROVIDER,
    fallbackProviderKey: SETTING_KEYS.AGENT_PROVIDER,
  },
  {
    modelKey: SETTING_KEYS.AGENT_CHORE_MODEL,
    trigger: '/settings agent.choreModel ',
    providerKey: SETTING_KEYS.AGENT_CHORE_PROVIDER,
    fallbackProviderKey: SETTING_KEYS.AGENT_PROVIDER,
  },
];

export const MODEL_SETTING_TRIGGERS = MODEL_SETTING_CONFIGS.map((config) => config.trigger);

export function getModelSettingConfig(modelKey: string): ModelSettingConfig | undefined {
  return MODEL_SETTING_CONFIGS.find((config) => config.modelKey === modelKey);
}

export function getModelSettingConfigForInput(input: string): ModelSettingConfig | undefined {
  return MODEL_SETTING_CONFIGS.find((config) => input.startsWith(config.trigger));
}
