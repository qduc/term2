import type { SlashCommand } from '../slash-commands.js';

export function createClearSlashCommand(
  clearConversation: () => void | Promise<void>,
  addSystemMessage: (text: string) => void,
): SlashCommand {
  return {
    name: 'clear',
    description: 'Start a new conversation',
    action: () => {
      void Promise.resolve(clearConversation()).then(() => {
        addSystemMessage('Welcome to term²! Type a message to start chatting.');
      });
    },
  };
}
