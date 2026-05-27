import type { SlashCommand } from '../slash-commands.js';
import type { Message } from '../hooks/use-conversation.js';
import { getLastFinalAssistantText } from '../utils/message-utils.js';
import { copyToClipboard } from '../utils/clipboard.js';

interface CreateCopySlashCommandOptions {
  messages: Message[];
  addSystemMessage: (text: string) => void;
  copy?: (text: string) => Promise<void>;
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
