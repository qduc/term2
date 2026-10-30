export const createCompactSlashCommand = (deps) => ({
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
            .catch((error) => deps.addSystemMessage(`Context compaction failed: ${error instanceof Error ? error.message : String(error)}`));
        return true;
    },
});
//# sourceMappingURL=compact-command.js.map