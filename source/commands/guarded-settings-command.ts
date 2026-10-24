import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { createSettingsCommand, parseSettingValue } from '../utils/settings-command.js';
import { BARE_ENABLED_DETAIL, type PendingModeSwitch } from './mode-commands.js';
import { planProfileTransition } from '../services/profiles/profile-transition.js';
import { ProfileResolutionError } from '../services/profiles/types.js';
import {
  BARE_PROFILE_ID,
  canonicalProfileId,
  isLegacyModeSettingKey,
  profileIdFromLegacyModeSetting,
} from '../services/profiles/legacy-adapter.js';

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
      const requestedKey = settingKey ?? '';
      const hasHistory = messages.some((msg) => msg.sender !== 'system');
      const currentProfileId = String(settingsService.get('app.activeProfileId'));
      let targetProfileId: string | undefined;
      if (isLegacyModeSettingKey(requestedKey)) {
        targetProfileId = profileIdFromLegacyModeSetting(
          requestedKey,
          isReset ? false : parseSettingValue(settingParts.slice(1).join(' ')),
          currentProfileId,
        );
      } else if (!isReset && requestedKey === 'app.activeProfileId') {
        const rawValue = settingParts.slice(1).join(' ');
        targetProfileId = rawValue.includes(':') ? rawValue : `builtin:${rawValue}`;
      }
      if (targetProfileId !== undefined) targetProfileId = canonicalProfileId(targetProfileId);
      const changesBareShape =
        targetProfileId !== undefined &&
        targetProfileId !== currentProfileId &&
        (targetProfileId === BARE_PROFILE_ID || currentProfileId === BARE_PROFILE_ID);
      if (changesBareShape && hasHistory) {
        const bareTargetProfileId = targetProfileId;
        if (requestModeSwitchConfirm) {
          requestModeSwitchConfirm({
            targetProfileId: bareTargetProfileId!,
            modeLabel: 'Bare',
            targetValue: bareTargetProfileId === BARE_PROFILE_ID,
            enabledDetail: BARE_ENABLED_DETAIL,
          });
          return true;
        }

        addSystemMessage(
          'Cannot switch modes mid-session (tool/context mismatch). Use `/clear` first, then change the profile.',
        );
        return true;
      }

      if (!isReset && requestedKey === 'app.activeProfileId') {
        const canonicalId = targetProfileId!;
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
