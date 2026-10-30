import { useCallback, useSyncExternalStore } from 'react';
export const useShellMode = ({ session, addShellMessage, replaceInput }) => {
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
    const enterShellMode = useCallback(() => session.enterShellMode(), [session]);
    const exitShellMode = useCallback(() => session.exitShellMode(), [session]);
    const handleShellSubmit = useCallback(async (value) => {
        const submission = session.submit(value);
        if (submission) {
            replaceInput('');
            try {
                const entry = await submission.completion;
                addShellMessage(entry.command, entry.output, entry.exitCode, entry.timedOut);
            }
            finally {
                exitShellMode();
            }
        }
    }, [addShellMessage, exitShellMode, replaceInput, session]);
    return {
        isShellMode: snapshot.isShellMode,
        activeCommand: snapshot.activeCommand,
        enterShellMode,
        exitShellMode,
        handleShellSubmit,
    };
};
//# sourceMappingURL=use-shell-mode.js.map