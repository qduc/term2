import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { AUTO_APPROVE_TRIGGER } from '../components/input/triggers.js';

interface CreateAutoApproveSlashCommandDeps {
  settingsService: SettingsService;
  applyRuntimeSetting: (key: string, value: any) => void;
  addSystemMessage: (text: string) => void;
}

export function createAutoApproveSlashCommand({
  settingsService,
  applyRuntimeSetting,
  addSystemMessage,
}: CreateAutoApproveSlashCommandDeps): SlashCommand {
  return {
    name: 'auto-approve',
    description: 'Set or cycle tool auto-approval mode (off, advisory, auto, always)',
    expectsArgs: true,
    completion: { type: 'setting-value', trigger: AUTO_APPROVE_TRIGGER, settingKey: 'shell.autoApproveMode' },
    action: (args?: string) => {
      const validModes = ['off', 'advisory', 'auto', 'always'] as const;
      let newValue: 'off' | 'advisory' | 'auto' | 'always';

      if (args && args.trim()) {
        const requested = args.trim().toLowerCase();
        if (validModes.includes(requested as any)) {
          newValue = requested as any;
        } else {
          addSystemMessage(`Error: Invalid mode '${args}'. Use: off, advisory, auto, or always.`);
          return false;
        }
      } else {
        const currentValue = settingsService.get('shell.autoApproveMode');
        if (currentValue === 'off') {
          newValue = 'advisory';
        } else if (currentValue === 'advisory') {
          newValue = 'auto';
        } else if (currentValue === 'auto') {
          newValue = 'always';
        } else {
          newValue = 'off';
        }
      }

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
