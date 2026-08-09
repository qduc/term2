import React, { FC, useEffect } from 'react';
import { useInput } from 'ink';
import InputBox from '../InputBox.js';
import { useInputContext } from '../../context/InputContext.js';
import { useSlashCommands } from '../../hooks/use-slash-commands.js';
import { usePathCompletion } from '../../hooks/use-path-completion.js';
import { useSettingsCompletion } from '../../hooks/use-settings-completion.js';
import { useSettingsValueCompletion } from '../../hooks/use-settings-value-completion.js';
import { useModelSelection } from '../../hooks/use-model-selection.js';
import { useSkillSelection } from '../../hooks/use-skill-selection.js';
import { createDefaultTriggerRegistry } from './triggers.js';
import { MenuSurface } from './MenuSurface.js';
import type { MenuServices } from './menu-registry.js';
import type { SlashCommand } from '../../slash-commands.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import type { LoggingService } from '../../services/logging/logging-service.js';
import type { HistoryService } from '../../services/history-service.js';
import type { SkillInfo, SkillsService } from '../../services/skills/skills-service.js';
import type { UserTurn } from '../../types/user-turn.js';
import type { SubmissionMutation } from '../../services/conversation/conversation-adapter.js';

export type ApplicationInputSurfaceProps = {
  enabled?: boolean;
  onSubmit: (value: UserTurn, options?: { busyMode?: 'steer' | 'follow_up' }) => void | Promise<void>;
  slashCommands: SlashCommand[];
  waitingForRejectionReason?: boolean;
  turnInFlight?: boolean;
  isShellMode?: boolean;
  settingsService: SettingsService;
  loggingService: LoggingService;
  historyService: HistoryService;
  onSettingChange?: (key: string, value: any) => void;
  onSystemMessage?: (text: string) => void;
  onSlashTabComplete?: (command: SlashCommand) => boolean;
  promptLabel?: string;
  allowEmptySubmit?: boolean;
  skillsService?: SkillsService;
  pendingQueuedMessages?: ReadonlyArray<{ id: string; text: string; queuedAt: number }>;
  onRetractQueuedMessage?: (id: string) => Promise<SubmissionMutation>;
  onEditQueuedMessage?: (id: string, turn: UserTurn) => Promise<SubmissionMutation>;
  onProviderSelected?: (provider: string) => void;
  onUnavailableModelSelected?: (provider: string) => void;
  onSkillSelected?: (skill: SkillInfo) => void;
};

export const ApplicationInputSurface: FC<ApplicationInputSurfaceProps> = (props) => {
  const enabled = props.enabled ?? true;
  const { controller, interactions, stack, cursorOffset, cursorOverride, setCursorOverride } = useInputContext();
  const slash = useSlashCommands({ commands: props.slashCommands, onClose: () => {} });
  const path = usePathCompletion({ loggingService: props.loggingService });
  const settings = useSettingsCompletion(props.settingsService);
  const settingsValue = useSettingsValueCompletion(props.settingsService);
  const models = useModelSelection({ loggingService: props.loggingService, settingsService: props.settingsService });
  const skills = useSkillSelection({
    skillsService: props.skillsService ?? ({ getAvailableSkills: () => [] } as unknown as SkillsService),
  });

  useEffect(() => {
    controller.setTriggerRegistry(
      createDefaultTriggerRegistry(props.slashCommands, [
        'slash',
        'path',
        'skills',
        'settings',
        'settings-value-child',
        'settings-model',
        'command-model',
        'direct-setting-value',
      ]),
    );
  }, [controller, props.slashCommands]);

  // MenuSurface is intentionally unmounted while the editor is active. Carry
  // the controller cursor through that handoff once so MultilineInput does not
  // snap back to the end of a value that was edited in the middle.
  useEffect(() => {
    if (stack.length === 0 && cursorOverride !== null && cursorOverride !== cursorOffset) {
      setCursorOverride(cursorOffset);
    }
  }, [cursorOffset, cursorOverride, setCursorOverride, stack.length]);

  // Keep Escape subscribed across the editor/menu remount. A key can arrive
  // after the controller opens a menu but before the replacement surface's
  // passive input effect is installed; the controller snapshot is the only
  // authoritative owner during that handoff.
  useInput(
    (_input, key) => {
      if (!enabled || !key.escape) return;
      if (controller.getSnapshot().stack.length === 0) return;

      controller.escape();
      setCursorOverride(controller.getSnapshot().editor.cursor);
    },
    { isActive: true },
  );

  const services: MenuServices = {
    settingsService: props.settingsService,
    slash,
    onSlashTabComplete: props.onSlashTabComplete,
    path,
    skills,
    settings,
    settingsValue,
    models,
    onProviderSelected: props.onProviderSelected,
    onUnavailableModelSelected: props.onUnavailableModelSelected,
    onSkillSelected: props.onSkillSelected,
    onSystemMessage: props.onSystemMessage,
  };

  if (stack.length > 0) {
    return (
      <MenuSurface
        stack={stack}
        controller={controller}
        interactions={interactions}
        services={services}
        enabled={enabled}
      />
    );
  }
  if (!enabled) return null;

  const { enabled: _enabled, ...inputBoxProps } = props;
  return (
    <InputBox
      {...inputBoxProps}
      // A newly mounted editor must receive the post-menu cursor in its first
      // render; waiting for an effect lets ink-prompt initialize at the end.
      cursorOverride={cursorOverride !== null ? cursorOffset : null}
    />
  );
};

export default ApplicationInputSurface;
