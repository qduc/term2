import { useCallback } from 'react';
import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { ProfileTransitionService, planProfileTransition } from '../services/profiles/profile-transition.js';
import { PROFILE_TRIGGER } from '../components/input/triggers.js';
import { resolveActiveProfile } from '../services/profiles/active-profile.js';
import { ProfileResolutionError } from '../services/profiles/types.js';
import { BARE_PROFILE_ID } from '../services/profiles/legacy-adapter.js';

export const BARE_ENABLED_DETAIL = ' - minimal prompt; AGENTS.md read on demand; other tools via run_code';

interface ModeHelpersDeps {
  settingsService: SettingsService;
  transitionService: ProfileTransitionService;
  addSystemMessage: (text: string) => void;
  messages?: { sender: string }[];
  requestModeSwitchConfirm?: (pending: PendingModeSwitch) => void;
}

export function useModeHelpers({
  settingsService,
  transitionService,
  addSystemMessage,
  messages = [],
  requestModeSwitchConfirm,
}: ModeHelpersDeps) {
  const togglePlanMode = useCallback(() => {
    const isPlan = resolveActiveProfile(settingsService).identity.id === 'builtin:plan';
    transitionService.activate(isPlan ? 'builtin:standard' : 'builtin:plan');
    addSystemMessage(`Plan mode ${isPlan ? 'disabled' : 'enabled - read-only research/planning mode'}`);
  }, [settingsService, transitionService, addSystemMessage]);

  const cycleAppModes = useCallback(() => {
    const isPlan = resolveActiveProfile(settingsService).identity.id === 'builtin:plan';
    const currentProfileId = resolveActiveProfile(settingsService).identity.id;
    const targetProfileId = isPlan ? 'builtin:standard' : 'builtin:plan';
    const hasHistory = messages.some((message) => message.sender !== 'system');
    if (currentProfileId === BARE_PROFILE_ID && hasHistory) {
      if (requestModeSwitchConfirm) {
        requestModeSwitchConfirm({ targetProfileId, modeLabel: 'Plan', targetValue: true });
      } else {
        addSystemMessage('Cannot switch modes mid-session (tool/context mismatch). Use `/clear` first.');
      }
      return;
    }
    transitionService.activate(isPlan ? 'builtin:standard' : 'builtin:plan');
    addSystemMessage(
      `Switched to ${isPlan ? 'Standard' : 'Plan'} mode${isPlan ? '' : ' - read-only research/planning mode'}`,
    );
  }, [settingsService, transitionService, addSystemMessage, messages, requestModeSwitchConfirm]);

  return { togglePlanMode, cycleAppModes };
}

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
 * Create a slash command for toggling an exclusive mode (bare, mentor, orchestrator).
 * Bare changes are confirmed or blocked when `messages` contains session history.
 */
export function createModeToggleCommand(
  profileId: 'bare' | 'mentor' | 'orchestrator',
  label: string,
  description: string,
  enabledDetail: string,
  deps: CreateModeToggleCommandDeps,
): SlashCommand {
  return {
    name: label,
    description,
    action: () => {
      const modeLabel = profileId.charAt(0).toUpperCase() + profileId.slice(1);
      const current = resolveActiveProfile(deps.settingsService);
      const targetProfileId =
        current.identity.id === `builtin:${profileId}` ? 'builtin:standard' : `builtin:${profileId}`;
      const targetValue = targetProfileId === `builtin:${profileId}`;

      // Bare changes the prompt/tool shape and must be confirmed when history exists.
      const hasHistory = deps.messages ? deps.messages.some((msg) => msg.sender !== 'system') : false;
      if (profileId === 'bare' && hasHistory) {
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
  settingsService,
  transitionService,
  addSystemMessage,
  replaceInput,
  messages,
  requestModeSwitchConfirm,
}: {
  settingsService: SettingsService;
  transitionService: ProfileTransitionService;
  addSystemMessage: (text: string) => void;
  replaceInput: (text: string) => void;
  messages?: { sender: string }[];
  requestModeSwitchConfirm?: (pending: PendingModeSwitch) => void;
}): SlashCommand {
  return {
    name: 'profile',
    description: 'Switch the active profile',
    expectsArgs: true,
    completion: { type: 'profile', trigger: PROFILE_TRIGGER },
    action: (args?: string) => {
      const rawId = args?.trim();
      if (!rawId) {
        replaceInput(PROFILE_TRIGGER);
        return false;
      }
      const targetId = rawId.includes(':') ? rawId : `builtin:${rawId}`;
      try {
        const currentId = resolveActiveProfile(settingsService).identity.id;
        const plannedTargetId = planProfileTransition(settingsService, targetId).targetId;
        const targetIsBare = plannedTargetId === BARE_PROFILE_ID;
        const currentIsBare = currentId === BARE_PROFILE_ID;
        const hasHistory = messages?.some((message) => message.sender !== 'system') ?? false;
        if (plannedTargetId !== currentId && (targetIsBare || currentIsBare) && hasHistory) {
          if (requestModeSwitchConfirm) {
            requestModeSwitchConfirm({
              targetProfileId: plannedTargetId,
              modeLabel: 'Bare',
              targetValue: targetIsBare,
              enabledDetail: BARE_ENABLED_DETAIL,
            });
          } else {
            addSystemMessage(
              `Cannot switch modes mid-session (tool/context mismatch). Use \`/clear\` first, then \`/profile ${rawId}\`.`,
            );
          }
          return true;
        }
        transitionService.activate(plannedTargetId);
      } catch (error) {
        if (!(error instanceof ProfileResolutionError)) throw error;
        addSystemMessage(error.message);
      }
      return true;
    },
  };
}
