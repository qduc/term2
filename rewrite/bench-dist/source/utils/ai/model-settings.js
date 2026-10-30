import { SETTING_KEYS } from '../../services/settings/settings-schema.js';
export const MODEL_CMD_TRIGGER = '/model ';
export const MODEL_SETTING_CONFIGS = [
    {
        modelKey: SETTING_KEYS.AGENT_MODEL_SELECTION,
        trigger: '/settings agent.modelSelection ',
    },
    {
        modelKey: SETTING_KEYS.AGENT_SMART_MODEL,
        trigger: '/settings agent.smartModel ',
        pool: true,
    },
    {
        modelKey: SETTING_KEYS.AGENT_BALANCED_MODEL,
        trigger: '/settings agent.balancedModel ',
        pool: true,
    },
    {
        modelKey: SETTING_KEYS.AGENT_CHEAP_MODEL,
        trigger: '/settings agent.cheapModel ',
        pool: true,
    },
    {
        modelKey: SETTING_KEYS.AGENT_CHORE_MODEL,
        trigger: '/settings agent.choreModel ',
        pool: true,
    },
];
// Tier model pools are excluded: typing their trigger opens the pool editor
// (settings-subagent-pool-child rule), not the single-model menu.
export const MODEL_SETTING_TRIGGERS = MODEL_SETTING_CONFIGS.filter((config) => !config.pool).map((config) => config.trigger);
export function getModelSettingConfig(modelKey) {
    return MODEL_SETTING_CONFIGS.find((config) => config.modelKey === modelKey);
}
export function getModelSettingConfigForInput(input) {
    return MODEL_SETTING_CONFIGS.find((config) => input.startsWith(config.trigger));
}
//# sourceMappingURL=model-settings.js.map