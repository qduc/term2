import type { SlashCommand } from '../slash-commands.js';
import type { Message } from '../types/message.js';
import { buildCopySelections, type CopySelection } from '../utils/copy-selections.js';
import { getAssistantResponseText } from '../utils/conversation/message-utils.js';
import { copyToClipboard } from '../utils/clipboard.js';

interface CreateCopySlashCommandOptions {
  messages: Message[];
  addSystemMessage: (text: string) => void;
  copy?: (text: string) => Promise<void>;
  openCopyMenu?: (selections: CopySelection[]) => void;
}

export function createCopySlashCommand({
  messages,
  addSystemMessage,
  copy = copyToClipboard,
  openCopyMenu,
}: CreateCopySlashCommandOptions): SlashCommand {
  return {
    name: 'copy',
    description: 'Copy an assistant response (latest by default; use /copy N to count backward)',
    action: (args?: string) => {
      const rawResponseNumber = args?.trim();
      let responseNumber = 1;
      if (rawResponseNumber) {
        if (!/^\d+$/.test(rawResponseNumber)) {
          addSystemMessage('Copy response number must be a positive whole number, e.g. /copy 2.');
          return true;
        }

        responseNumber = Number(rawResponseNumber);
        if (!Number.isSafeInteger(responseNumber) || responseNumber < 1) {
          addSystemMessage('Copy response number must be a positive whole number, e.g. /copy 2.');
          return true;
        }
      }

      const assistantText = getAssistantResponseText(messages, responseNumber);
      if (!assistantText) {
        if (responseNumber === 1) {
          addSystemMessage('No assistant response is available to copy yet.');
        } else {
          addSystemMessage(`No assistant response #${responseNumber} (counting from latest) is available to copy.`);
        }
        return true;
      }

      const selections = buildCopySelections(assistantText);
      if (selections.length > 1 && openCopyMenu) {
        openCopyMenu(selections);
        return true;
      }

      void copy(assistantText)
        .then(() => {
          const responseLabel =
            responseNumber === 1
              ? 'the latest assistant response'
              : `assistant response #${responseNumber} (counting from latest)`;
          addSystemMessage(`Copied ${responseLabel} to the clipboard.`);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          addSystemMessage(`Failed to copy to clipboard: ${message}`);
        });

      return true;
    },
  };
}
