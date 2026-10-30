import { AUTO_APPROVE_TRIGGER } from '../components/input/triggers.js';
import { AUTO_APPROVE_MODE_DESCRIPTIONS } from '../utils/value-suggestions.js';
export function createAutoApproveSlashCommand({ settingsService, applyRuntimeSetting, addSystemMessage, replaceInput, }) {
    return {
        name: 'auto-approve',
        description: 'Set tool auto-approval mode (off, advisory, auto, always)',
        expectsArgs: true,
        completion: { type: 'setting-value', trigger: AUTO_APPROVE_TRIGGER, settingKey: 'shell.autoApproveMode' },
        action: (args) => {
            if (!args) {
                replaceInput(AUTO_APPROVE_TRIGGER);
                return false;
            }
            const parts = args.trim().split(/\s+/).filter(Boolean);
            if (parts.length === 0) {
                replaceInput(AUTO_APPROVE_TRIGGER);
                return false;
            }
            const validModes = ['off', 'advisory', 'auto', 'always'];
            const requested = parts.join(' ').toLowerCase();
            if (!validModes.includes(requested)) {
                addSystemMessage(`Error: Invalid mode '${args}'. Use: off, advisory, auto, or always.`);
                return false;
            }
            const newValue = requested;
            settingsService.set('shell.autoApproveMode', newValue);
            applyRuntimeSetting('shell.autoApproveMode', newValue);
            addSystemMessage(`Tool auto-approval mode set to: ${newValue.toUpperCase()}. ${AUTO_APPROVE_MODE_DESCRIPTIONS[newValue]}`);
            return true;
        },
    };
}
//# sourceMappingURL=auto-approve-command.js.map