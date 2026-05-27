import type { SlashCommand } from '../slash-commands.js';
import type { UserTurn } from '../types/user-turn.js';

interface CreateRetrySlashCommandOptions {
  undoLastUserMessage: () => { text: string; images?: UserTurn['images'] } | null;
  sendUserMessage: (input: string | UserTurn) => Promise<void>;
  addSystemMessage: (text: string) => void;
  listUserTurns: () => { index: number; text: string; imageCount: number }[];
  onUndo?: () => void;
}

export function createRetrySlashCommand({
  undoLastUserMessage,
  sendUserMessage,
  addSystemMessage,
  listUserTurns,
  onUndo,
}: CreateRetrySlashCommandOptions): SlashCommand {
  return {
    name: 'retry',
    description: 'Retry the last user message',
    expectsArgs: true,
    action: (args?: string) => {
      if (args?.trim() === 'list') {
        const turns = listUserTurns();
        if (turns.length === 0) {
          addSystemMessage('No user messages to retry.');
          return true;
        }
        const turnList = turns
          .map((turn) => `[${turn.index}] ${turn.text}${turn.imageCount > 0 ? ` (${turn.imageCount} image(s))` : ''}`)
          .join('\n');
        addSystemMessage(`Available turns to retry:\n${turnList}`);
        return true;
      }

      const removed = undoLastUserMessage();
      if (removed) {
        onUndo?.();
        void sendUserMessage({ text: removed.text, ...(removed.images?.length ? { images: removed.images } : {}) });
        return true;
      }

      addSystemMessage('Nothing to retry.');
      return true;
    },
  };
}
