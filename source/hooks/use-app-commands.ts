import { useMemo, useCallback } from 'react';
import type { SlashCommand } from '../components/SlashCommandMenu.js';
import type { SettingsService } from '../services/settings-service.js';
import { createSettingsCommand } from '../utils/settings-command.js';
import { getProvider } from '../providers/index.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { Message } from './use-conversation.js';

interface UseAppCommandsProps {
  settingsService: SettingsService;
  addSystemMessage: (text: string) => void;
  applyRuntimeSetting: (key: string, value: any) => void;
  setInput: (input: string) => void;
  clearConversation: () => void;
  exit: () => void;
  messages: Message[];
  setModel: (model: string) => void;
}

export function getLastFinalAssistantText(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.sender === 'bot' && typeof message.text === 'string' && message.text.length > 0) {
      return message.text;
    }
  }

  return null;
}

export const useAppCommands = ({
  settingsService,
  addSystemMessage,
  applyRuntimeSetting,
  setInput,
  clearConversation,
  exit,
  messages,
  setModel,
}: UseAppCommandsProps) => {
  const toggleEditMode = useCallback(() => {
    const currentValue = settingsService.get<boolean>('app.editMode');
    const newValue = !currentValue;

    // Edit mode is mutually exclusive with lite mode
    if (newValue) {
      const liteMode = settingsService.get<boolean>('app.liteMode');
      if (liteMode) {
        settingsService.set('app.liteMode', false);
        applyRuntimeSetting('app.liteMode', false);
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
      {
        name: 'copy',
        description: 'Copy the latest final assistant response',
        action: () => {
          const lastAssistantText = getLastFinalAssistantText(messages);
          if (!lastAssistantText) {
            addSystemMessage('No assistant response is available to copy yet.');
            return true;
          }

          try {
            copyToClipboard(lastAssistantText);
            addSystemMessage('Copied the latest assistant response to the clipboard.');
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            addSystemMessage(`Failed to copy to clipboard: ${message}`);
          }

          return true;
        },
      },
      {
        name: 'clear',
        description: 'Start a new conversation',
        action: () => {
          clearConversation();
          addSystemMessage('Welcome to term²! Type a message to start chatting.');
        },
      },
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
        action: (args?: string) => {
          if (!args) {
            setInput('/model ');
            return false;
          }

          // Parse model and provider from args
          // Format: "model-id --provider=providerid" or just "model-id"
          const providerMatch = args.match(/--provider=(\w+)/);
          const modelId = args.replace(/\s*--provider=\w+\s*/, '').trim();

          // Validate provider if specified
          if (providerMatch) {
            const provider = providerMatch[1];
            if (!getProvider(provider)) {
              addSystemMessage(`Error: Unknown provider '${provider}'`);
              return false;
            }
          }

          // Update settings and runtime
          settingsService.set('agent.model', modelId);
          applyRuntimeSetting('agent.model', modelId);

          let providerMsg = '';
          if (providerMatch) {
            const provider = providerMatch[1];
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
        action: autoApproveAction,
      },
      settingsCommand,
    ];
  }, [addSystemMessage, applyRuntimeSetting, clearConversation, exit, messages, setModel, setInput, settingsService]);

  return {
    slashCommands,
    toggleEditMode,
  };
};
