import type { SlashCommand } from '../slash-commands.js';

export const createCompactSlashCommand = (deps: {
  compactContext: () => Promise<string>;
  addSystemMessage: (text: string) => void;
}): SlashCommand => ({
  name: 'compact',
  description: 'Compact older conversation turns into a local summary',
  action: () => {
    // compactContext emits started/completed events on the service sink, which
    // the interactive UI never attaches while idle. Announce immediately so a
    // long summarizer call is not a blank screen.
    deps.addSystemMessage('Compacting context...');
    void deps
      .compactContext()
      .then(deps.addSystemMessage)
      .catch((error: unknown) =>
        deps.addSystemMessage(`Context compaction failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    return true;
  },
});
