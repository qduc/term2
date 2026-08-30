import { useCallback, useSyncExternalStore } from 'react';
import { ShellInteractionSession } from '../services/shell/shell-interaction-session.js';

interface UseShellModeProps {
  session: ShellInteractionSession;
  addShellMessage: (command: string, output: string, exitCode: number | null, timedOut: boolean) => void;
  replaceInput: (input: string) => void;
}

export const useShellMode = ({ session, addShellMessage, replaceInput }: UseShellModeProps) => {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

  const enterShellMode = useCallback(() => session.enterShellMode(), [session]);

  const exitShellMode = useCallback(() => session.exitShellMode(), [session]);

  const handleShellSubmit = useCallback(
    async (value: string) => {
      const submission = session.submit(value);
      if (submission) {
        replaceInput('');
        try {
          const entry = await submission.completion;
          addShellMessage(entry.command, entry.output, entry.exitCode, entry.timedOut);
        } finally {
          exitShellMode();
        }
      }
    },
    [addShellMessage, exitShellMode, replaceInput, session],
  );

  return {
    isShellMode: snapshot.isShellMode,
    enterShellMode,
    exitShellMode,
    handleShellSubmit,
  };
};
