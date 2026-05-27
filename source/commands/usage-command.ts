import type { SlashCommand } from '../slash-commands.js';

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
