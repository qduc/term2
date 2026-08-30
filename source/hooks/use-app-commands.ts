import { useMemo } from 'react';
import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import type { UserTurn } from '../types/user-turn.js';
import { useModeHelpers, createModeToggleCommand, type PendingModeSwitch } from '../commands/mode-commands.js';
import { createCopySlashCommand } from '../commands/copy-command.js';
import { createUsageSlashCommand } from '../commands/usage-command.js';
import { createClearSlashCommand } from '../commands/clear-command.js';
import { createRewindSlashCommand, type RewindDisposition } from '../commands/rewind-command.js';
import { createRetryToolSlashCommand } from '../commands/retry-tool-command.js';
import { createQuitSlashCommand } from '../commands/quit-command.js';
import { createModelSlashCommand } from '../commands/model-command.js';
import { createAutoApproveSlashCommand } from '../commands/auto-approve-command.js';
import { createSandboxSlashCommand } from '../commands/sandbox-command.js';
import { createEffortSlashCommand } from '../commands/effort-command.js';
import { createHandoffSlashCommand } from '../commands/handoff-command.js';
import { createGuardedSettingsCommand } from '../commands/guarded-settings-command.js';
import { createSkillsSlashCommand } from '../commands/skills-command.js';
import { createCompactSlashCommand } from '../commands/compact-command.js';
import { guardAgainstBusyTurn } from '../utils/busy-turn-guard.js';
import type { SkillsService, SkillInfo } from '../services/skills/skills-service.js';
import type { Message } from '../types/message.js';
import type { CopySelection } from '../utils/copy-selections.js';
import type { RewindItem } from '../utils/conversation/rewind-items.js';

interface UseAppCommandsProps {
  settingsService: SettingsService;
  addSystemMessage: (text: string) => void;
  applyRuntimeSetting: (key: string, value: any) => void;
  replaceInput: (input: string) => void;
  clearConversation: () => void | Promise<void>;
  getSessionUsage: () => string;
  refreshProviderUsage?: () => void;
  exit: () => void;
  messages: Message[];
  setModel: (model: string) => void;
  getRewindItems: () => readonly RewindItem[];
  rewindToTarget: (item: RewindItem) => { text: string; images?: UserTurn['images'] } | null;
  restoreTurnToInput: (turn: { text: string; images?: UserTurn['images'] }) => void;
  openRewindMenu: (disposition: RewindDisposition) => void;
  openProvidersMenu: () => void;
  openCopyMenu?: (selections: CopySelection[]) => void;
  onRewind?: () => void;
  onHandoff?: (capturedText: string) => void;
  sendUserMessage: (input: string | UserTurn) => Promise<void>;
  retryLastToolOutput: () => Promise<boolean>;
  compactContext?: () => Promise<string>;
  skillsService: SkillsService;
  onSkillSelected: (skill: SkillInfo) => void;
  requestModeSwitchConfirm?: (pending: PendingModeSwitch) => void;
  /** True while an agent turn is in flight; gates conversation-mutating commands. */
  turnInFlight?: boolean;
}

// Re-export for backward compat
export { getLastFinalAssistantText } from '../utils/conversation/message-utils.js';
export { createCopySlashCommand } from '../commands/copy-command.js';
export { createUsageSlashCommand } from '../commands/usage-command.js';
export { createRewindSlashCommand } from '../commands/rewind-command.js';
export { createRetryToolSlashCommand } from '../commands/retry-tool-command.js';

export const useAppCommands = ({
  settingsService,
  addSystemMessage,
  applyRuntimeSetting,
  replaceInput,
  clearConversation,
  getSessionUsage,
  refreshProviderUsage,
  exit,
  messages,
  getRewindItems,
  rewindToTarget,
  restoreTurnToInput,
  openRewindMenu,
  openProvidersMenu,
  openCopyMenu,
  onRewind,
  onHandoff,
  sendUserMessage,
  retryLastToolOutput,
  compactContext = async () => 'Context compaction is unavailable.',
  skillsService,
  onSkillSelected,
  requestModeSwitchConfirm,
  turnInFlight = false,
}: UseAppCommandsProps) => {
  const { disableOtherModes, togglePlanMode, cycleAppModes } = useModeHelpers({
    settingsService,
    applyRuntimeSetting,
    addSystemMessage,
  });

  const slashCommands = useMemo<SlashCommand[]>(() => {
    // Shared by /rewind and its two aliases so they cannot drift apart.
    const rewindDeps = {
      getRewindItems,
      rewindToTarget,
      restoreTurnToInput,
      sendUserMessage,
      addSystemMessage,
      openRewindMenu,
      onRewind,
    };

    // These actions abort the active turn, replace the conversation, or race
    // it (rewind/retry, retry-tool, clear, quit, compact). Every dispatch
    // path funnels through the command objects, so guarding here covers the
    // typed submit, the intent host, and the slash menu at once.
    const guardBusyTurn = (command: SlashCommand) =>
      guardAgainstBusyTurn(command, { turnInFlight: () => turnInFlight, notify: addSystemMessage });

    return [
      createModelSlashCommand({ settingsService, applyRuntimeSetting, addSystemMessage, replaceInput }),
      createEffortSlashCommand({ settingsService, applyRuntimeSetting, addSystemMessage, replaceInput }),
      guardBusyTurn(createClearSlashCommand(clearConversation, addSystemMessage)),
      createCopySlashCommand({ messages, addSystemMessage, openCopyMenu }),
      createUsageSlashCommand(addSystemMessage, getSessionUsage, refreshProviderUsage),
      guardBusyTurn(
        createRewindSlashCommand({
          name: 'rewind',
          defaultDisposition: 'edit',
          bareTarget: 'picker',
          ...rewindDeps,
        }),
      ),
      // Aliases keep existing muscle memory working: bare /undo opened a picker
      // and bare /retry acted on the last turn immediately, so each keeps that.
      guardBusyTurn(
        createRewindSlashCommand({
          name: 'undo',
          aliasOf: 'rewind',
          defaultDisposition: 'edit',
          bareTarget: 'picker',
          ...rewindDeps,
        }),
      ),
      guardBusyTurn(
        createRewindSlashCommand({
          name: 'retry',
          aliasOf: 'rewind',
          defaultDisposition: 'resend',
          bareTarget: 'last',
          ...rewindDeps,
        }),
      ),
      guardBusyTurn(createRetryToolSlashCommand({ retryLastToolOutput, addSystemMessage })),
      guardBusyTurn(createCompactSlashCommand({ compactContext, addSystemMessage })),
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
          requestModeSwitchConfirm,
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
      createGuardedSettingsCommand({
        settingsService,
        addSystemMessage,
        applyRuntimeSetting,
        replaceInput,
        messages,
        requestModeSwitchConfirm,
      }),
      createSandboxSlashCommand({ settingsService, applyRuntimeSetting, addSystemMessage }),
      {
        name: 'providers',
        description: 'Manage API providers (list, add, edit, delete)',
        action: () => {
          openProvidersMenu();
          return true;
        },
      },
      createSkillsSlashCommand({ skillsService, onSkillSelected, addSystemMessage, replaceInput }),
      guardBusyTurn(createQuitSlashCommand(exit)),
    ];
  }, [
    addSystemMessage,
    applyRuntimeSetting,
    clearConversation,
    disableOtherModes,
    exit,
    getSessionUsage,
    refreshProviderUsage,
    messages,
    replaceInput,
    settingsService,
    getRewindItems,
    rewindToTarget,
    restoreTurnToInput,
    openRewindMenu,
    openProvidersMenu,
    openCopyMenu,
    onRewind,
    onHandoff,
    sendUserMessage,
    retryLastToolOutput,
    compactContext,
    togglePlanMode,
    skillsService,
    onSkillSelected,
    requestModeSwitchConfirm,
    turnInFlight,
  ]);

  return {
    slashCommands,
    togglePlanMode,
    cycleAppModes,
  };
};
