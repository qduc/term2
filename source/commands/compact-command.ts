import type { SlashCommand } from '../slash-commands.js';

export const createCompactSlashCommand = (deps: {
  compactContext: () => Promise<string>;
  addSystemMessage: (text: string) => void;
}): SlashCommand => ({
  name: 'compact',
  description: 'Compact older conversation turns into a local summary',
  action: () => {
    void deps
      .compactContext()
      .then(deps.addSystemMessage)
      .catch((error: unknown) =>
        deps.addSystemMessage(`Context compaction failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    return true;
  },
});
