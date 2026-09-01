import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { createSettingsCommand, parseSettingValue } from '../utils/settings-command.js';
import type { PendingModeSwitch } from './mode-commands.js';
import { planProfileTransition } from '../services/profiles/profile-transition.js';
import { ProfileResolutionError } from '../services/profiles/types.js';

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
            targetProfileId: 'builtin:lite',
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

      if (!isReset && settingKey === 'app.activeProfileId') {
        const rawValue = settingParts.slice(1).join(' ');
        const canonicalId = rawValue.includes(':') ? rawValue : `builtin:${rawValue}`;
        try {
          planProfileTransition(settingsService, canonicalId);
        } catch (error) {
          if (!(error instanceof ProfileResolutionError)) throw error;
          addSystemMessage(`Cannot switch to profile '${canonicalId}': ${error.message}`);
          return true;
        }
        return settingsCommand.action(`app.activeProfileId ${canonicalId}`);
      }

      return settingsCommand.action(args);
    },
  };
}
