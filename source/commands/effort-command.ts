import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { parseSettingValue } from '../utils/settings-command.js';
import { EFFORT_TRIGGER } from '../components/input/triggers.js';

interface CreateEffortSlashCommandDeps {
  settingsService: SettingsService;
  applyRuntimeSetting: (key: string, value: any) => void;
  addSystemMessage: (text: string) => void;
  setInput: (input: string) => void;
}

export function createEffortSlashCommand({
  settingsService,
  applyRuntimeSetting,
  addSystemMessage,
  setInput,
}: CreateEffortSlashCommandDeps): SlashCommand {
  return {
    name: 'effort',
    description: 'Set reasoning effort (alias for /settings agent.reasoningEffort)',
    expectsArgs: true,
    completion: { type: 'setting-value', trigger: EFFORT_TRIGGER, settingKey: 'agent.reasoningEffort' },
    action: (args?: string) => {
      if (!args) {
        setInput('/effort ');
        return false;
      }

      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        setInput('/effort ');
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
