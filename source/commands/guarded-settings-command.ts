import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { createSettingsCommand, parseSettingValue } from '../utils/settings-command.js';
import type { ExclusiveModeKey, PendingModeSwitch } from './mode-commands.js';

interface CreateGuardedSettingsCommandDeps {
  settingsService: SettingsService;
  addSystemMessage: (text: string) => void;
  applyRuntimeSetting?: (key: string, value: any) => void;
  replaceInput: (value: string) => void;
  messages: { sender: string }[];
  requestModeSwitchConfirm?: (pending: PendingModeSwitch) => void;
}

export function createGuardedSettingsCommand({
  settingsService,
  addSystemMessage,
  applyRuntimeSetting,
  replaceInput,
  messages,
  requestModeSwitchConfirm,
}: CreateGuardedSettingsCommandDeps): SlashCommand {
  const settingsCommand = createSettingsCommand({
    settingsService,
    addSystemMessage,
    applyRuntimeSetting,
    replaceInput,
  });

  return {
    ...settingsCommand,
    action: (args?: string) => {
      const settingParts = args?.trim().split(/\s+/) ?? [];
      const isReset = settingParts[0] === 'reset';
      const settingKey = isReset ? settingParts[1] : settingParts[0];
      const hasHistory = messages.some((msg) => msg.sender !== 'system');
      if (settingKey === 'app.liteMode' && hasHistory) {
        if (requestModeSwitchConfirm) {
          const rawVal = isReset ? false : parseSettingValue(settingParts.slice(1).join(' '));
          const targetValue = typeof rawVal === 'boolean' ? rawVal : true;
          requestModeSwitchConfirm({
            modeKey: settingKey as ExclusiveModeKey,
            modeLabel: 'Lite',
            targetValue,
            enabledDetail: ' - using minimal prompt, no codebase context',
          });
          return true;
        }

        addSystemMessage(
          'Cannot switch modes mid-session (tool/context mismatch). Use `/clear` first, then change lite mode.',
        );
        return true;
      }

      return settingsCommand.action(args);
    },
  };
}
