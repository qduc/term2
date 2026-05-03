import { useState, useCallback, useEffect } from 'react';
import type { ConversationService } from '../services/conversation-service.js';
import type { SettingsService } from '../services/settings-service.js';
import { ISSHService } from '../services/service-interfaces.js';
import { executeShellCommand } from '../utils/execute-shell.js';
import { trimOutput } from '../utils/output-trim.js';

const SHELL_MAX_BUFFER = 1024 * 1024;

export interface SSHInfo {
  host: string;
  user: string;
  remoteDir: string;
}

export interface ShellHistoryEntry {
  command: string;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

interface UseShellModeProps {
  settingsService: SettingsService;
  conversationService: ConversationService;
  addShellMessage: (command: string, output: string, exitCode: number | null, timedOut: boolean) => void;
  setInput: (input: string) => void;
  liteMode: boolean;
  sshInfo?: SSHInfo;
  sshService?: ISSHService;
}

export const useShellMode = ({
  settingsService,
  conversationService,
  addShellMessage,
  setInput,
  liteMode,
  sshInfo,
  sshService,
}: UseShellModeProps) => {
  const [isShellMode, setIsShellMode] = useState(false);
  const [shellHistory, setShellHistory] = useState<ShellHistoryEntry[]>([]);

  const formatShellHistory = useCallback((entries: ShellHistoryEntry[]) => {
    if (entries.length === 0) {
      return '';
    }

    const blocks = entries.map((entry) => {
      const lines = [`$ ${entry.command}`];
      const output = entry.output.trim();
      if (output) {
        lines.push(output);
      }
      lines.push(`Exit: ${entry.timedOut ? 'timeout' : entry.exitCode != null ? entry.exitCode : 'null'}`);
      return lines.join('\n');
    });

    return ['[Previous Shell Session]', ...blocks].join('\n\n');
  }, []);

  const flushShellHistory = useCallback(() => {
    if (shellHistory.length === 0) {
      return;
    }
    const historyText = formatShellHistory(shellHistory);
    if (historyText) {
      conversationService.addShellContext(historyText);
    }
    setShellHistory([]);
  }, [shellHistory, formatShellHistory, conversationService]);

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
    if (!liteMode && isShellMode) {
      setIsShellMode(false);
      flushShellHistory();
    }
  }, [liteMode, isShellMode, flushShellHistory]);

  const handleShellSubmit = useCallback(
    async (value: string) => {
      const commandText = value.trim();
      if (!commandText) {
        return;
      }

      const timeoutValue = settingsService.get<number>('shell.timeout');
      const timeout = timeoutValue != null ? timeoutValue : undefined;
      const maxOutputLengthValue = settingsService.get<number>('shell.maxOutputChars');
      const maxOutputLength = maxOutputLengthValue != null ? maxOutputLengthValue : undefined;

      setInput('');

      const result = await executeShellCommand(commandText, {
        timeout,
        maxBuffer: SHELL_MAX_BUFFER,
        sshService,
        cwd: sshInfo?.remoteDir,
      });

      const stdoutTrimmed = trimOutput(result.stdout ?? '', undefined, maxOutputLength).trimEnd();
      const stderrTrimmed = trimOutput(result.stderr ?? '', undefined, maxOutputLength).trimEnd();
      const combinedOutput = [stdoutTrimmed, stderrTrimmed].filter(Boolean).join('\n').trimEnd();

      addShellMessage(commandText, combinedOutput, result.exitCode, result.timedOut);
      setShellHistory((prev) => [
        ...prev,
        {
          command: commandText,
          output: combinedOutput,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        },
      ]);
    },
    [settingsService, setInput, addShellMessage, sshService, sshInfo],
  );

  return {
    isShellMode,
    toggleShellMode,
    handleShellSubmit,
    flushShellHistory,
  };
};
