import type { SlashCommand } from '../slash-commands.js';

export const createRetryFailedTurnSlashCommand = (deps: {
  retryLastFailedTurn: () => Promise<boolean>;
  addSystemMessage: (text: string) => void;
}): SlashCommand => ({
  name: 'retry-turn',
  description: 'Retry the last turn the provider failed to complete',
  action: () => {
    void deps.retryLastFailedTurn().then((succeeded) => {
      if (!succeeded) deps.addSystemMessage('Retry did not produce a new response.');
    });
    return true;
  },
});
