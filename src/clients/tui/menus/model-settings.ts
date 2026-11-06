/** Copied from src/shared/utils/ai/model-settings.ts with SETTING_KEYS inlined. */

export type ModelSettingConfig = {
  modelKey: string;
  trigger: string;
  /**
   * True when the setting is a tier model pool: it is still handled by the
   * settings command (including the --provider flag) but does not open the
   * single-model menu; the pool editor owns its UI instead.
   */
  pool?: boolean;
};

const MODEL_SETTING_CONFIGS: ModelSettingConfig[] = [
  {
    modelKey: 'agent.modelSelection',
    trigger: '/settings agent.modelSelection ',
  },
  {
    modelKey: 'agent.smartModel',
    trigger: '/settings agent.smartModel ',
    pool: true,
  },
  {
    modelKey: 'agent.balancedModel',
    trigger: '/settings agent.balancedModel ',
    pool: true,
  },
  {
    modelKey: 'agent.cheapModel',
    trigger: '/settings agent.cheapModel ',
    pool: true,
  },
  {
    modelKey: 'agent.choreModel',
    trigger: '/settings agent.choreModel ',
    pool: true,
  },
];

// Tier model pools are excluded: typing their trigger opens the pool editor
// (settings-subagent-pool-child rule), not the single-model menu.
export const MODEL_SETTING_TRIGGERS = MODEL_SETTING_CONFIGS.filter((config) => !config.pool).map(
  (config) => config.trigger,
);

export function getModelSettingConfig(modelKey: string): ModelSettingConfig | undefined {
  return MODEL_SETTING_CONFIGS.find((config) => config.modelKey === modelKey);
}

export function getModelSettingConfigForInput(input: string): ModelSettingConfig | undefined {
  return MODEL_SETTING_CONFIGS.find((config) => input.startsWith(config.trigger));
}
