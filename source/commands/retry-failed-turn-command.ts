import type { SlashCommand } from '../slash-commands.js';

export const createRetryFailedTurnSlashCommand = (deps: {
  retryLastFailedTurn: () => Promise<boolean>;
  addSystemMessage: (text: string) => void;
  addDividerMessage: () => void;
}): SlashCommand => ({
  name: 'retry-turn',
  description: 'Regenerate the latest user turn from its original prompt',
  action: () => {
    // The regeneration removes the old turn from the canonical transcript and
    // UI, so a divider inserted here would be part of the content being cleared.
    void deps.retryLastFailedTurn().then((succeeded) => {
      if (!succeeded) deps.addSystemMessage('Retry did not produce a new response.');
    });
    return true;
  },
});
