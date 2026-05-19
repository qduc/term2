import { useMemo, useCallback } from 'react';
import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings-service.js';
import { createSettingsCommand, parseSettingValue } from '../utils/settings-command.js';
import { getProvider } from '../providers/index.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { Message } from './use-conversation.js';
import { parseModelProviderArg } from '../utils/model-provider-arg.js';
import { MODEL_CMD_TRIGGER } from '../utils/model-settings.js';
import { AUTO_APPROVE_TRIGGER, EFFORT_TRIGGER } from '../components/Input/triggers.js';

interface UseAppCommandsProps {
  settingsService: SettingsService;
  addSystemMessage: (text: string) => void;
  applyRuntimeSetting: (key: string, value: any) => void;
  setInput: (input: string) => void;
  clearConversation: () => void;
  getSessionUsage: () => string;
  exit: () => void;
  messages: Message[];
  setModel: (model: string) => void;
  undoLastUserMessage: () => string | null;
  openUndoMenu: () => void;
}

interface CreateCopySlashCommandOptions {
  messages: Message[];
  addSystemMessage: (text: string) => void;
  copy?: (text: string) => Promise<void>;
}

interface CreateUndoSlashCommandOptions {
  undoLastUserMessage: () => string | null;
  setInput: (input: string) => void;
  addSystemMessage: (text: string) => void;
  openUndoMenu: () => void;
}

export function getLastFinalAssistantText(messages: Message[]): string | null {
  let lastBotIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.sender === 'bot' && typeof message.text === 'string' && message.text.length > 0) {
      lastBotIndex = index;
      break;
    }
  }

  if (lastBotIndex === -1) {
    return null;
  }

  const texts: string[] = [];
  for (let index = lastBotIndex; index >= 0; index--) {
    const message = messages[index];
    if (message?.sender === 'bot') {
      if (typeof message.text === 'string') {
        texts.unshift(message.text);
      }
    } else {
      break;
    }
  }

  return texts.join('').trim() || null;
}

export function createUsageSlashCommand(
  addSystemMessage: (text: string) => void,
  getSessionUsage: () => string,
): SlashCommand {
  return {
    name: 'usage',
    description: 'Show token usage for the current session',
    action: () => {
      addSystemMessage(getSessionUsage());
      return true;
    },
  };
}

export function createCopySlashCommand({
  messages,
  addSystemMessage,
  copy = copyToClipboard,
}: CreateCopySlashCommandOptions): SlashCommand {
  return {
    name: 'copy',
    description: 'Copy the latest final assistant response',
    action: () => {
      const lastAssistantText = getLastFinalAssistantText(messages);
      if (!lastAssistantText) {
        addSystemMessage('No assistant response is available to copy yet.');
        return true;
      }

      void copy(lastAssistantText)
        .then(() => {
          addSystemMessage('Copied the latest assistant response to the clipboard.');
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          addSystemMessage(`Failed to copy to clipboard: ${message}`);
        });

      return true;
    },
  };
}

export function createUndoSlashCommand({
  undoLastUserMessage,
  setInput,
  addSystemMessage,
  openUndoMenu,
}: CreateUndoSlashCommandOptions): SlashCommand {
  return {
    name: 'undo',
    description: 'Select a previous message to undo back to',
    action: (args?: string) => {
      // /undo with no args: open the selection menu
      if (!args || args.trim() === '') {
        openUndoMenu();
        return true; // clear input
      }
      // /undo last — immediate undo of last message
      if (args.trim() === 'last') {
        const text = undoLastUserMessage();
        if (text !== null) {
          setInput(text);
          return false;
        }
        addSystemMessage('Nothing to undo.');
        return true;
      }
      return true;
    },
  };
}

export const useAppCommands = ({
  settingsService,
  addSystemMessage,
  applyRuntimeSetting,
  setInput,
  clearConversation,
  getSessionUsage,
  exit,
  messages,
  setModel,
  undoLastUserMessage,
  openUndoMenu,
}: UseAppCommandsProps) => {
  const toggleEditMode = useCallback(() => {
    const currentValue = settingsService.get<boolean>('app.editMode');
    const newValue = !currentValue;

    // Edit mode is mutually exclusive with lite mode and plan mode
    if (newValue) {
      const liteMode = settingsService.get<boolean>('app.liteMode');
      const planMode = settingsService.get<boolean>('app.planMode');
      if (liteMode) {
        settingsService.set('app.liteMode', false);
        applyRuntimeSetting('app.liteMode', false);
      }
      if (planMode) {
        settingsService.set('app.planMode', false);
        applyRuntimeSetting('app.planMode', false);
      }
    }

    settingsService.set('app.editMode', newValue);
    applyRuntimeSetting('app.editMode', newValue);

    addSystemMessage(
      `Edit mode ${newValue ? 'enabled' : 'disabled'}${
        newValue ? ' - auto-approving file patches within workspace' : ''
      }`,
    );
  }, [settingsService, applyRuntimeSetting, addSystemMessage]);

  const togglePlanMode = useCallback(() => {
    const currentValue = settingsService.get<boolean>('app.planMode');
    const newValue = !currentValue;

    // Plan mode is mutually exclusive with edit mode and lite mode
    if (newValue) {
      const editMode = settingsService.get<boolean>('app.editMode');
      const liteMode = settingsService.get<boolean>('app.liteMode');
      if (editMode) {
        settingsService.set('app.editMode', false);
        applyRuntimeSetting('app.editMode', false);
      }
      if (liteMode) {
        settingsService.set('app.liteMode', false);
        applyRuntimeSetting('app.liteMode', false);
      }
    }

    settingsService.set('app.planMode', newValue);
    applyRuntimeSetting('app.planMode', newValue);

    addSystemMessage(
      `Plan mode ${newValue ? 'enabled' : 'disabled'}${newValue ? ' - read-only research/planning mode' : ''}`,
    );
  }, [settingsService, applyRuntimeSetting, addSystemMessage]);

  const cycleAppModes = useCallback(() => {
    const editMode = settingsService.get<boolean>('app.editMode');
    const planMode = settingsService.get<boolean>('app.planMode');

    let nextEditMode = false;
    let nextPlanMode = false;
    let modeName = 'Default';
    let detail = '';

    if (!editMode && !planMode) {
      // Default -> Edit
      nextEditMode = true;
      nextPlanMode = false;
      modeName = 'Edit';
      detail = ' - auto-approving file patches within workspace';
    } else if (editMode) {
      // Edit -> Plan
      nextEditMode = false;
      nextPlanMode = true;
      modeName = 'Plan';
      detail = ' - read-only research/planning mode';
    } else {
      // Plan -> Default
      nextEditMode = false;
      nextPlanMode = false;
      modeName = 'Default';
      detail = '';
    }

    const applyIfChanged = (key: 'app.editMode' | 'app.planMode', current: boolean, next: boolean) => {
      if (current === next) return;
      settingsService.set(key, next);
      applyRuntimeSetting(key, next);
    };

    // Apply disables before enables so the two modes are never simultaneously true.
    // Only emit a change (and its runtime mode notice) when the value actually flips.
    if (!nextEditMode) applyIfChanged('app.editMode', editMode, false);
    if (!nextPlanMode) applyIfChanged('app.planMode', planMode, false);
    if (nextEditMode) applyIfChanged('app.editMode', editMode, true);
    if (nextPlanMode) applyIfChanged('app.planMode', planMode, true);

    addSystemMessage(`Switched to ${modeName} mode${detail}`);
  }, [settingsService, applyRuntimeSetting, addSystemMessage]);

  const slashCommands: SlashCommand[] = useMemo(() => {
    const settingsCommand = createSettingsCommand({
      settingsService,
      addSystemMessage,
      applyRuntimeSetting,
      setInput,
    });

    const autoApproveAction = (args?: string) => {
      const validModes = ['off', 'advisory', 'auto'] as const;
      let newValue: 'off' | 'advisory' | 'auto';

      if (args && args.trim()) {
        const requested = args.trim().toLowerCase();
        if (validModes.includes(requested as any)) {
          newValue = requested as any;
        } else {
          addSystemMessage(`Error: Invalid mode '${args}'. Use: off, advisory, or auto.`);
          return false;
        }
      } else {
        const currentValue = settingsService.get<'off' | 'advisory' | 'auto'>('shell.autoApproveMode');
        if (currentValue === 'off') {
          newValue = 'advisory';
        } else if (currentValue === 'advisory') {
          newValue = 'auto';
        } else {
          newValue = 'off';
        }
      }

      settingsService.set('shell.autoApproveMode', newValue);
      applyRuntimeSetting('shell.autoApproveMode', newValue);

      addSystemMessage(`Shell auto-approval mode set to: ${newValue.toUpperCase()}`);
      return true;
    };

    return [
      createCopySlashCommand({ messages, addSystemMessage }),
      createUsageSlashCommand(addSystemMessage, getSessionUsage),
      {
        name: 'clear',
        description: 'Start a new conversation',
        action: () => {
          clearConversation();
          addSystemMessage('Welcome to term²! Type a message to start chatting.');
        },
      },
      createUndoSlashCommand({ undoLastUserMessage, setInput, addSystemMessage, openUndoMenu }),
      {
        name: 'quit',
        description: 'Exit the application',
        action: () => {
          exit();
        },
      },
      {
        name: 'model',
        description: 'Change the AI model (e.g. /model gpt-4)',
        expectsArgs: true,
        completion: { type: 'model', trigger: MODEL_CMD_TRIGGER },
        action: (args?: string) => {
          if (!args) {
            setInput('/model ');
            return false;
          }

          const { modelId, provider } = parseModelProviderArg(args);

          if (provider) {
            if (!getProvider(provider)) {
              addSystemMessage(`Error: Unknown provider '${provider}'`);
              return false;
            }
          }

          // Update settings and runtime
          settingsService.set('agent.model', modelId);
          applyRuntimeSetting('agent.model', modelId);

          let providerMsg = '';
          if (provider) {
            settingsService.set('agent.provider', provider);
            applyRuntimeSetting('agent.provider', provider);
            providerMsg = ` (${provider})`;
          }

          addSystemMessage(`Set model to ${modelId}${providerMsg}`);

          return true;
        },
      },
      {
        name: 'mentor',
        description: 'Toggle mentor mode (collaborative mode with mentor model)',
        action: () => {
          const currentValue = settingsService.get<boolean>('app.mentorMode');
          const newValue = !currentValue;

          // Mentor mode is mutually exclusive with lite mode
          if (newValue) {
            const liteMode = settingsService.get<boolean>('app.liteMode');
            if (liteMode) {
              settingsService.set('app.liteMode', false);
              applyRuntimeSetting('app.liteMode', false);
            }
          }

          settingsService.set('app.mentorMode', newValue);
          applyRuntimeSetting('app.mentorMode', newValue);

          addSystemMessage(
            `Mentor mode ${newValue ? 'enabled' : 'disabled'}${
              newValue ? ' - using simplified mentor prompt and ask_mentor tool' : ''
            }`,
          );

          return true;
        },
      },
      {
        name: 'lite',
        description: 'Toggle lite mode (minimal context, session-only)',
        action: () => {
          const hasHistory = messages.filter((msg) => msg.sender !== 'system').length > 0;

          if (hasHistory) {
            addSystemMessage(
              'Cannot switch modes mid-session (tool/context mismatch). Use `/clear` first, then `/lite`.',
            );
            return true;
          }

          const currentValue = settingsService.get<boolean>('app.liteMode');
          const newValue = !currentValue;

          // Lite mode is mutually exclusive with edit/mentor modes
          if (newValue) {
            const editMode = settingsService.get<boolean>('app.editMode');
            const mentorMode = settingsService.get<boolean>('app.mentorMode');

            if (editMode) {
              settingsService.set('app.editMode', false);
              applyRuntimeSetting('app.editMode', false);
            }
            if (mentorMode) {
              settingsService.set('app.mentorMode', false);
              applyRuntimeSetting('app.mentorMode', false);
            }
          }

          settingsService.set('app.liteMode', newValue);
          applyRuntimeSetting('app.liteMode', newValue);

          addSystemMessage(
            `Lite mode ${newValue ? 'enabled - using minimal prompt, no codebase context' : 'disabled'}`,
          );
          return true;
        },
      },
      {
        name: 'auto-approve',
        description: 'Set or cycle shell auto-approval mode (off, advisory, auto)',
        expectsArgs: true,
        completion: { type: 'setting-value', trigger: AUTO_APPROVE_TRIGGER, settingKey: 'shell.autoApproveMode' },
        action: autoApproveAction,
      },
      {
        name: 'effort',
        description: 'Set reasoning effort (alias for /settings agent.reasoningEffort)',
        expectsArgs: true,
        completion: { type: 'setting-value', trigger: EFFORT_TRIGGER, settingKey: 'agent.reasoningEffort' },
        action: (args?: string) => {
          if (!args) {
            setInput('/effort ');
            return false;
          }

          // Reuse settings command logic for agent.reasoningEffort
          const parts = args.trim().split(/\s+/).filter(Boolean);
          if (parts.length === 0) {
            setInput('/effort ');
            return false;
          }

          const rawValue = parts.join(' ');
          const parsedValue = parseSettingValue(rawValue);

          if (!settingsService.isRuntimeModifiable('agent.reasoningEffort')) {
            addSystemMessage(`Cannot modify 'agent.reasoningEffort' at runtime. Restart required.`);
            return true;
          }

          settingsService.set('agent.reasoningEffort', parsedValue);
          if (applyRuntimeSetting) {
            applyRuntimeSetting('agent.reasoningEffort', parsedValue);
          }
          addSystemMessage(`Set agent.reasoningEffort to ${parsedValue}`);
          return true;
        },
      },
      {
        name: 'plan',
        description: 'Toggle plan mode (read-only research/planning mode)',
        action: () => {
          togglePlanMode();
          return true;
        },
      },
      settingsCommand,
    ];
  }, [
    addSystemMessage,
    applyRuntimeSetting,
    clearConversation,
    exit,
    getSessionUsage,
    messages,
    setModel,
    setInput,
    settingsService,
    undoLastUserMessage,
    openUndoMenu,
    togglePlanMode,
  ]);

  return {
    slashCommands,
    toggleEditMode,
    togglePlanMode,
    cycleAppModes,
  };
};
