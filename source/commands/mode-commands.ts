import { useCallback } from 'react';
import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings-service.js';

/** All exclusive mode keys. */
export const EXCLUSIVE_MODE_KEYS = ['app.liteMode', 'app.orchestratorMode', 'app.planMode', 'app.mentorMode'] as const;
type ExclusiveModeKey = (typeof EXCLUSIVE_MODE_KEYS)[number];

interface ModeHelpersDeps {
  settingsService: SettingsService;
  applyRuntimeSetting: (key: string, value: any) => void;
  addSystemMessage: (text: string) => void;
}

export function useModeHelpers({ settingsService, applyRuntimeSetting, addSystemMessage }: ModeHelpersDeps) {
  const disableOtherModes = useCallback(
    (except: ExclusiveModeKey) => {
      for (const key of EXCLUSIVE_MODE_KEYS) {
        if (key !== except && settingsService.get<boolean>(key)) {
          settingsService.set(key, false);
          applyRuntimeSetting(key, false);
        }
      }
    },
    [settingsService, applyRuntimeSetting],
  );

  const togglePlanMode = useCallback(() => {
    const currentValue = settingsService.get<boolean>('app.planMode');
    const newValue = !currentValue;

    if (newValue) {
      disableOtherModes('app.planMode');
    }

    settingsService.set('app.planMode', newValue);
    applyRuntimeSetting('app.planMode', newValue);

    addSystemMessage(
      `Plan mode ${newValue ? 'enabled' : 'disabled'}${newValue ? ' - read-only research/planning mode' : ''}`,
    );
  }, [settingsService, applyRuntimeSetting, addSystemMessage, disableOtherModes]);

  const cycleAppModes = useCallback(() => {
    const planMode = settingsService.get<boolean>('app.planMode');
    const nextPlanMode = !planMode;
    const modeName = nextPlanMode ? 'Plan' : 'Standard';
    const detail = nextPlanMode ? ' - read-only research/planning mode' : '';

    if (nextPlanMode) {
      disableOtherModes('app.planMode');
    }

    settingsService.set('app.planMode', nextPlanMode);
    applyRuntimeSetting('app.planMode', nextPlanMode);

    addSystemMessage(`Switched to ${modeName} mode${detail}`);
  }, [settingsService, applyRuntimeSetting, addSystemMessage, disableOtherModes]);

  return { disableOtherModes, togglePlanMode, cycleAppModes };
}

export type { ExclusiveModeKey };

interface CreateModeToggleCommandDeps {
  settingsService: SettingsService;
  applyRuntimeSetting: (key: string, value: any) => void;
  addSystemMessage: (text: string) => void;
  disableOtherModes: (except: ExclusiveModeKey) => void;
}

/**
 * Create a slash command for toggling an exclusive mode (lite, mentor, orchestrator).
 * When `messages` is provided, the command will block toggling mid-session.
 */
export function createModeToggleCommand(
  modeKey: ExclusiveModeKey,
  label: string,
  description: string,
  enabledDetail: string,
  deps: CreateModeToggleCommandDeps & { messages?: { sender: string }[] },
): SlashCommand {
  return {
    name: label,
    description,
    action: () => {
      // History guard: some modes (lite, orchestrator) can't toggle mid-session.
      const hasHistory = deps.messages ? deps.messages.some((msg) => msg.sender !== 'system') : false;
      if (hasHistory) {
        deps.addSystemMessage(
          `Cannot switch modes mid-session (tool/context mismatch). Use \`/clear\` first, then \`/${label}\`.`,
        );
        return true;
      }

      const modeLabel = label.charAt(0).toUpperCase() + label.slice(1);
      const newValue = !deps.settingsService.get<boolean>(modeKey);
      if (newValue) {
        deps.disableOtherModes(modeKey);
      }

      deps.settingsService.set(modeKey, newValue);
      deps.applyRuntimeSetting(modeKey, newValue);

      deps.addSystemMessage(`${modeLabel} mode ${newValue ? `enabled${enabledDetail}` : 'disabled'}`);
      return true;
    },
  };
}
