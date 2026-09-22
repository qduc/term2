import type { SlashCommand } from '../slash-commands.js';

export const createRetryFailedTurnSlashCommand = (deps: {
  retryLastFailedTurn: () => Promise<boolean>;
  addSystemMessage: (text: string) => void;
  addDividerMessage: () => void;
}): SlashCommand => ({
  name: 'retry-turn',
  description: 'Retry the last turn the provider failed to complete',
  action: () => {
    // Mark where the new attempt begins: the failed turn's rows above stay put,
    // and everything below the divider is the retry's output.
    deps.addDividerMessage();
    void deps.retryLastFailedTurn().then((succeeded) => {
      if (!succeeded) deps.addSystemMessage('Retry did not produce a new response.');
    });
    return true;
  },
});
