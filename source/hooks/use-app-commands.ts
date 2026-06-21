import { useMemo } from 'react';
import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import type { UserTurn } from '../types/user-turn.js';
import { useModeHelpers, createModeToggleCommand } from '../commands/mode-commands.js';
import { createCopySlashCommand } from '../commands/copy-command.js';
import { createUsageSlashCommand } from '../commands/usage-command.js';
import { createClearSlashCommand } from '../commands/clear-command.js';
import { createUndoSlashCommand } from '../commands/undo-command.js';
import { createRetrySlashCommand } from '../commands/retry-command.js';
import { createQuitSlashCommand } from '../commands/quit-command.js';
import { createModelSlashCommand } from '../commands/model-command.js';
import { createAutoApproveSlashCommand } from '../commands/auto-approve-command.js';
import { createEffortSlashCommand } from '../commands/effort-command.js';
import { createHandoffSlashCommand } from '../commands/handoff-command.js';
import { createGuardedSettingsCommand } from '../commands/guarded-settings-command.js';
import { createSkillsSlashCommand } from '../commands/skills-command.js';
import type { SkillsService, SkillInfo } from '../services/skills/skills-service.js';
import type { Message } from '../types/message.js';

interface UseAppCommandsProps {
  settingsService: SettingsService;
  addSystemMessage: (text: string) => void;
  applyRuntimeSetting: (key: string, value: any) => void;
  replaceInput: (input: string) => void;
  clearConversation: () => void | Promise<void>;
  getSessionUsage: () => string;
  exit: () => void;
  messages: Message[];
  setModel: (model: string) => void;
  undoLastUserMessage: () => { text: string; images?: UserTurn['images'] } | null;
  openUndoMenu: () => void;
  openProvidersMenu: () => void;
  onUndo?: () => void;
  onHandoff?: (capturedText: string) => void;
  sendUserMessage: (input: string | UserTurn) => Promise<void>;
  listUserTurns: () => { index: number; text: string; imageCount: number }[];
  skillsService: SkillsService;
  onSkillSelected: (skill: SkillInfo) => void;
}

// Re-export for backward compat
export { getLastFinalAssistantText } from '../utils/conversation/message-utils.js';
export { createCopySlashCommand } from '../commands/copy-command.js';
export { createUsageSlashCommand } from '../commands/usage-command.js';
export { createUndoSlashCommand } from '../commands/undo-command.js';
export { createRetrySlashCommand } from '../commands/retry-command.js';

export const useAppCommands = ({
  settingsService,
  addSystemMessage,
  applyRuntimeSetting,
  replaceInput,
  clearConversation,
  getSessionUsage,
  exit,
  messages,
  undoLastUserMessage,
  openUndoMenu,
  openProvidersMenu,
  onUndo,
  onHandoff,
  sendUserMessage,
  listUserTurns,
  skillsService,
  onSkillSelected,
}: UseAppCommandsProps) => {
  const { disableOtherModes, togglePlanMode, cycleAppModes } = useModeHelpers({
    settingsService,
    applyRuntimeSetting,
    addSystemMessage,
  });

  const slashCommands = useMemo<SlashCommand[]>(
    () => [
      createModelSlashCommand({ settingsService, applyRuntimeSetting, addSystemMessage, replaceInput }),
      createEffortSlashCommand({ settingsService, applyRuntimeSetting, addSystemMessage, replaceInput }),
      createClearSlashCommand(clearConversation, addSystemMessage),
      createCopySlashCommand({ messages, addSystemMessage }),
      createUsageSlashCommand(addSystemMessage, getSessionUsage),
      createUndoSlashCommand({ undoLastUserMessage, replaceInput, addSystemMessage, openUndoMenu, onUndo }),
      createRetrySlashCommand({ undoLastUserMessage, sendUserMessage, addSystemMessage, listUserTurns, onUndo }),
      createModeToggleCommand(
        'app.liteMode',
        'lite',
        'Toggle lite mode (minimal context, session-only)',
        ' - using minimal prompt, no codebase context',
        {
          settingsService,
          applyRuntimeSetting,
          addSystemMessage,
          disableOtherModes,
          messages,
        },
      ),
      createModeToggleCommand(
        'app.mentorMode',
        'mentor',
        'Toggle mentor mode (collaborative mode with mentor model)',
        ' - using simplified mentor prompt and ask_mentor tool',
        {
          settingsService,
          applyRuntimeSetting,
          addSystemMessage,
          disableOtherModes,
        },
      ),
      createModeToggleCommand(
        'app.orchestratorMode',
        'orchestrator',
        'Toggle orchestrator mode (delegate all tool-backed work)',
        ' - tool-backed work must use subagents',
        {
          settingsService,
          applyRuntimeSetting,
          addSystemMessage,
          disableOtherModes,
          messages,
        },
      ),
      createAutoApproveSlashCommand({ settingsService, applyRuntimeSetting, addSystemMessage }),
      {
        name: 'plan',
        description: 'Toggle plan mode (read-only research/planning mode)',
        action: () => {
          togglePlanMode();
          return true;
        },
      },
      createHandoffSlashCommand({ messages, addSystemMessage, onHandoff }),
      createGuardedSettingsCommand({ settingsService, addSystemMessage, applyRuntimeSetting, replaceInput, messages }),
      {
        name: 'providers',
        description: 'Manage API providers (list, add, edit, delete)',
        action: () => {
          openProvidersMenu();
          return true;
        },
      },
      createQuitSlashCommand(exit),
      createSkillsSlashCommand({ skillsService, onSkillSelected, addSystemMessage, replaceInput }),
    ],
    [
      addSystemMessage,
      applyRuntimeSetting,
      clearConversation,
      disableOtherModes,
      exit,
      getSessionUsage,
      messages,
      replaceInput,
      settingsService,
      undoLastUserMessage,
      openUndoMenu,
      openProvidersMenu,
      onUndo,
      onHandoff,
      sendUserMessage,
      listUserTurns,
      togglePlanMode,
      skillsService,
      onSkillSelected,
    ],
  );

  return {
    slashCommands,
    togglePlanMode,
    cycleAppModes,
  };
};
