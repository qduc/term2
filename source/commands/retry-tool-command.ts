import type { SlashCommand } from '../slash-commands.js';

interface CreateRetryToolSlashCommandOptions {
  retryLastToolOutput: () => Promise<boolean>;
  addSystemMessage: (text: string) => void;
}

/**
 * Re-runs the last tool call rather than rewinding a user turn. This used to be
 * `/retry tool`, which put an unrelated verb inside the rewind command's
 * argument grammar.
 */
export function createRetryToolSlashCommand({
  retryLastToolOutput,
  addSystemMessage,
}: CreateRetryToolSlashCommandOptions): SlashCommand {
  return {
    name: 'retry-tool',
    description: 'Retry the last tool call',
    action: () => {
      void retryLastToolOutput().then((retried) => {
        if (!retried) {
          addSystemMessage('No tool call to retry.');
        }
      });
      return true;
    },
  };
}
