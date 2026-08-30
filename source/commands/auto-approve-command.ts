import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { AUTO_APPROVE_TRIGGER } from '../components/input/triggers.js';

interface CreateAutoApproveSlashCommandDeps {
  settingsService: SettingsService;
  applyRuntimeSetting: (key: string, value: any) => void;
  addSystemMessage: (text: string) => void;
  replaceInput: (input: string) => void;
}

export function createAutoApproveSlashCommand({
  settingsService,
  applyRuntimeSetting,
  addSystemMessage,
  replaceInput,
}: CreateAutoApproveSlashCommandDeps): SlashCommand {
  return {
    name: 'auto-approve',
    description: 'Set tool auto-approval mode (off, advisory, auto, always)',
    expectsArgs: true,
    completion: { type: 'setting-value', trigger: AUTO_APPROVE_TRIGGER, settingKey: 'shell.autoApproveMode' },
    action: (args?: string) => {
      if (!args) {
        replaceInput(AUTO_APPROVE_TRIGGER);
        return false;
      }

      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        replaceInput(AUTO_APPROVE_TRIGGER);
        return false;
      }

      const validModes = ['off', 'advisory', 'auto', 'always'] as const;
      const requested = parts.join(' ').toLowerCase();
      if (!validModes.includes(requested as any)) {
        addSystemMessage(`Error: Invalid mode '${args}'. Use: off, advisory, auto, or always.`);
        return false;
      }

      const newValue = requested as 'off' | 'advisory' | 'auto' | 'always';
      settingsService.set('shell.autoApproveMode', newValue);
      applyRuntimeSetting('shell.autoApproveMode', newValue);

      if (newValue === 'always') {
        addSystemMessage(
          'Tool auto-approval mode set to: ALWAYS. Sandbox disabled — every tool runs without a permission prompt (YOLO). Clarifying questions still use ask_user.',
        );
      } else {
        addSystemMessage(`Tool auto-approval mode set to: ${newValue.toUpperCase()}`);
      }
      return true;
    },
  };
}
