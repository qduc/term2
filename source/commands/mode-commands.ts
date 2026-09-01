import { useCallback } from 'react';
import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { ProfileTransitionService } from '../services/profiles/profile-transition.js';
import { resolveActiveProfile } from '../services/profiles/active-profile.js';
import { ProfileResolutionError } from '../services/profiles/types.js';

/** All exclusive mode keys. */
export const EXCLUSIVE_MODE_KEYS = ['app.liteMode', 'app.orchestratorMode', 'app.planMode', 'app.mentorMode'] as const;
type ExclusiveModeKey = (typeof EXCLUSIVE_MODE_KEYS)[number];

interface ModeHelpersDeps {
  settingsService: SettingsService;
  transitionService: ProfileTransitionService;
  addSystemMessage: (text: string) => void;
}

export function useModeHelpers({ settingsService, transitionService, addSystemMessage }: ModeHelpersDeps) {
  const togglePlanMode = useCallback(() => {
    const isPlan = resolveActiveProfile(settingsService).identity.id === 'builtin:plan';
    transitionService.activate(isPlan ? 'builtin:standard' : 'builtin:plan');
    addSystemMessage(`Plan mode ${isPlan ? 'disabled' : 'enabled - read-only research/planning mode'}`);
  }, [settingsService, transitionService, addSystemMessage]);

  const cycleAppModes = useCallback(() => {
    const isPlan = resolveActiveProfile(settingsService).identity.id === 'builtin:plan';
    transitionService.activate(isPlan ? 'builtin:standard' : 'builtin:plan');
    addSystemMessage(
      `Switched to ${isPlan ? 'Standard' : 'Plan'} mode${isPlan ? '' : ' - read-only research/planning mode'}`,
    );
  }, [settingsService, transitionService, addSystemMessage]);

  return { togglePlanMode, cycleAppModes };
}

export type { ExclusiveModeKey };

export interface PendingModeSwitch {
  targetProfileId: string;
  modeLabel: string;
  targetValue: boolean;
  enabledDetail?: string;
}

export interface CreateModeToggleCommandDeps {
  settingsService: SettingsService;
  transitionService: ProfileTransitionService;
  addSystemMessage: (text: string) => void;
  messages?: { sender: string }[];
  requestModeSwitchConfirm?: (pending: PendingModeSwitch) => void;
}

/**
 * Create a slash command for toggling an exclusive mode (lite, mentor, orchestrator).
 * Lite changes are confirmed or blocked when `messages` contains session history.
 */
export function createModeToggleCommand(
  profileId: 'lite' | 'mentor' | 'orchestrator',
  label: string,
  description: string,
  enabledDetail: string,
  deps: CreateModeToggleCommandDeps,
): SlashCommand {
  return {
    name: label,
    description,
    action: () => {
      const modeLabel = label.charAt(0).toUpperCase() + label.slice(1);
      const current = resolveActiveProfile(deps.settingsService);
      const targetProfileId =
        current.identity.id === `builtin:${profileId}` ? 'builtin:standard' : `builtin:${profileId}`;
      const targetValue = targetProfileId === `builtin:${profileId}`;

      // Lite changes the prompt/tool shape and must be confirmed when history exists.
      const hasHistory = deps.messages ? deps.messages.some((msg) => msg.sender !== 'system') : false;
      if (profileId === 'lite' && hasHistory) {
        if (deps.requestModeSwitchConfirm) {
          deps.requestModeSwitchConfirm({
            targetProfileId,
            modeLabel,
            targetValue,
            enabledDetail,
          });
          return true;
        }

        deps.addSystemMessage(
          `Cannot switch modes mid-session (tool/context mismatch). Use \`/clear\` first, then \`/${label}\`.`,
        );
        return true;
      }

      deps.transitionService.activate(targetProfileId);
      deps.addSystemMessage(`${modeLabel} mode ${targetValue ? `enabled${enabledDetail}` : 'disabled'}`);
      return true;
    },
  };
}

export function createProfileCommand({
  settingsService: _settingsService,
  transitionService,
  addSystemMessage,
}: {
  settingsService: SettingsService;
  transitionService: ProfileTransitionService;
  addSystemMessage: (text: string) => void;
}): SlashCommand {
  return {
    name: 'profile',
    description: 'Switch the active profile',
    expectsArgs: true,
    action: (args?: string) => {
      const rawId = args?.trim();
      if (!rawId) {
        addSystemMessage('Available profiles: standard, lite, plan, mentor, orchestrator (usage: /profile <id>)');
        return true;
      }
      const targetId = rawId.includes(':') ? rawId : `builtin:${rawId}`;
      try {
        transitionService.activate(targetId);
      } catch (error) {
        if (!(error instanceof ProfileResolutionError)) throw error;
        addSystemMessage(error.message);
      }
      return true;
    },
  };
}
