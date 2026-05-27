import type { SlashCommand } from '../slash-commands.js';

export function createQuitSlashCommand(exit: () => void): SlashCommand {
  return {
    name: 'quit',
    description: 'Exit the application',
    action: () => {
      exit();
    },
  };
}
