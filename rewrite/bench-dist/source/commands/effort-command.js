import { parseSettingValue } from '../utils/settings-command.js';
import { EFFORT_TRIGGER } from '../components/input/triggers.js';
export function createEffortSlashCommand({ settingsService, applyRuntimeSetting, addSystemMessage, replaceInput, }) {
    return {
        name: 'effort',
        description: 'Choose the model reasoning effort (Ctrl+T)',
        expectsArgs: true,
        completion: { type: 'setting-value', trigger: EFFORT_TRIGGER, settingKey: 'agent.reasoningEffort' },
        action: (args) => {
            if (!args) {
                replaceInput('/effort ');
                return false;
            }
            const parts = args.trim().split(/\s+/).filter(Boolean);
            if (parts.length === 0) {
                replaceInput('/effort ');
                return false;
            }
            const rawValue = parts.join(' ');
            const parsedValue = parseSettingValue(rawValue);
            if (!settingsService.isRuntimeModifiable('agent.reasoningEffort')) {
                addSystemMessage(`Cannot modify 'agent.reasoningEffort' at runtime. Restart required.`);
                return true;
            }
            settingsService.set('agent.reasoningEffort', parsedValue);
            if (applyRuntimeSetting) {
                applyRuntimeSetting('agent.reasoningEffort', parsedValue);
            }
            addSystemMessage(`Set agent.reasoningEffort to ${parsedValue}`);
            return true;
        },
    };
}
//# sourceMappingURL=effort-command.js.map