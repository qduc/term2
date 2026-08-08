import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { ShellInteractionSession } from '../services/shell/shell-interaction-session.js';

interface UseShellModeProps {
  session: ShellInteractionSession;
  addShellMessage: (command: string, output: string, exitCode: number | null, timedOut: boolean) => void;
  replaceInput: (input: string) => void;
  liteMode: boolean;
}

export const useShellMode = ({ session, addShellMessage, replaceInput, liteMode }: UseShellModeProps) => {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

  const flushShellHistory = useCallback(() => session.flushShellHistory(), [session]);

  const toggleShellMode = useCallback(() => session.toggleShellMode(), [session]);

  useEffect(() => {
    session.setLiteMode(liteMode);
  }, [liteMode, session]);

  const handleShellSubmit = useCallback(
    async (value: string) => {
      const submission = session.submit(value);
      if (submission) {
        replaceInput('');
        const entry = await submission.completion;
        addShellMessage(entry.command, entry.output, entry.exitCode, entry.timedOut);
      }
    },
    [addShellMessage, replaceInput, session],
  );

  return {
    isShellMode: snapshot.isShellMode,
    toggleShellMode,
    handleShellSubmit,
    flushShellHistory,
  };
};
