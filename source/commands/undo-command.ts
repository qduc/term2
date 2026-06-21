import type { SlashCommand } from '../slash-commands.js';
import type { UserTurn } from '../types/user-turn.js';

interface CreateUndoSlashCommandOptions {
  undoLastUserMessage: () => { text: string; images?: UserTurn['images'] } | null;
  replaceInput: (input: string) => void;
  addSystemMessage: (text: string) => void;
  openUndoMenu: () => void;
  onUndo?: () => void;
}

export function createUndoSlashCommand({
  undoLastUserMessage,
  replaceInput,
  addSystemMessage,
  openUndoMenu,
  onUndo,
}: CreateUndoSlashCommandOptions): SlashCommand {
  return {
    name: 'undo',
    description: 'Undo the last user message, optionally select a specific turn',
    expectsArgs: true,
    action: (args?: string) => {
      if (!args || args.trim() === '') {
        // No args: open the undo selection menu
        openUndoMenu();
        return true;
      }

      if (args.trim() === 'last') {
        const removed = undoLastUserMessage();
        if (!removed) {
          addSystemMessage('Nothing to undo.');
          return true;
        }

        replaceInput(removed.text);
        onUndo?.();
        return false;
      }

      // Named turn index - look it up via the menu flow
      openUndoMenu();
      return true;
    },
  };
}
