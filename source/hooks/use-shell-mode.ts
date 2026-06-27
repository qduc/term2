import { useState, useCallback, useEffect } from 'react';
import type { ConversationService } from '../services/conversation/conversation-service.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { ISSHService } from '../services/service-interfaces.js';
import {
  executeFormattedShellCommand,
  serializeShellHistory,
  type ShellHistoryEntry,
} from '../utils/shell/shell-session.js';

export interface SSHInfo {
  host: string;
  user: string;
  remoteDir: string;
}

interface UseShellModeProps {
  settingsService: SettingsService;
  conversationService: ConversationService;
  addShellMessage: (command: string, output: string, exitCode: number | null, timedOut: boolean) => void;
  replaceInput: (input: string) => void;
  liteMode: boolean;
  sshInfo?: SSHInfo;
  sshService?: ISSHService;
}

export const useShellMode = ({
  settingsService,
  conversationService,
  addShellMessage,
  replaceInput,
  liteMode,
  sshInfo,
  sshService,
}: UseShellModeProps) => {
  const [isShellMode, setIsShellMode] = useState(false);
  const [shellHistory, setShellHistory] = useState<ShellHistoryEntry[]>([]);

  const flushShellHistory = useCallback(() => {
    if (shellHistory.length === 0) {
      return;
    }
    const historyText = serializeShellHistory(shellHistory);
    if (historyText) {
      conversationService.addShellContext(historyText);
    }
    setShellHistory([]);
  }, [shellHistory, conversationService]);

  const toggleShellMode = useCallback(() => {
    setIsShellMode((prev) => {
      const next = !prev;
      if (prev && !next) {
        flushShellHistory();
      }
      return next;
    });
  }, [flushShellHistory]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!liteMode && isShellMode) {
      setIsShellMode(false);
      flushShellHistory();
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [liteMode, isShellMode, flushShellHistory]);

  const handleShellSubmit = useCallback(
    async (value: string) => {
      const commandText = value.trim();
      if (!commandText) {
        return;
      }

      replaceInput('');

      const result = await executeFormattedShellCommand({
        command: commandText,
        settingsService,
        sshInfo,
        sshService,
      });

      addShellMessage(commandText, result.text, result.exitCode, result.timedOut);
      setShellHistory((prev) => [
        ...prev,
        {
          command: commandText,
          output: result.text,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        },
      ]);
    },
    [settingsService, replaceInput, addShellMessage, sshService, sshInfo],
  );

  return {
    isShellMode,
    toggleShellMode,
    handleShellSubmit,
    flushShellHistory,
  };
};
