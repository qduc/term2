import type { SlashCommand } from '../slash-commands.js';
import type { Message } from '../hooks/use-conversation.js';
import { getLastFinalAssistantText } from '../utils/message-utils.js';

interface CreateHandoffSlashCommandDeps {
  messages: Message[];
  addSystemMessage: (text: string) => void;
  onHandoff?: (capturedText: string) => void;
}

export function createHandoffSlashCommand({
  messages,
  addSystemMessage,
  onHandoff,
}: CreateHandoffSlashCommandDeps): SlashCommand {
  return {
    name: 'handoff',
    description: 'Hand off the last assistant response to another model',
    action: () => {
      const lastText = getLastFinalAssistantText(messages);
      if (!lastText) {
        addSystemMessage('No assistant response available to hand off.');
        return true;
      }

      onHandoff?.(lastText);
      return true;
    },
  };
}
