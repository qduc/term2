import process from 'node:process';
import type { SettingsService } from '../../services/settings/settings-service.js';
import type { ISSHService } from '../../services/service-interfaces.js';
import { SHELL_CONTEXT_PREFIX } from '../../services/conversation/conversation-store.js';
import { executeShellCommand } from './execute-shell.js';
import { formatShellExecutionOutput } from './shell-output.js';

export interface ShellHistoryEntry {
  command: string;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

export function serializeShellHistory(entries: ShellHistoryEntry[]): string {
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

  return [SHELL_CONTEXT_PREFIX, ...blocks].join('\n\n');
}

export async function executeFormattedShellCommand(params: {
  command: string;
  settingsService: Pick<SettingsService, 'get'>;
  sshInfo?: { remoteDir: string };
  sshService?: ISSHService;
}): Promise<{ text: string; exitCode: number | null; timedOut: boolean }> {
  const timeoutValue = params.settingsService.get<number>('shell.timeout');
  const timeout = timeoutValue != null ? timeoutValue : undefined;
  const maxOutputLengthValue = params.settingsService.get<number>('shell.maxOutputChars');
  const maxOutputLength = maxOutputLengthValue != null ? maxOutputLengthValue : undefined;
  const startedAt = Date.now();

  const result = await executeShellCommand(params.command, {
    timeout,
    maxBuffer: 1024 * 1024,
    sshService: params.sshService,
    cwd: params.sshInfo?.remoteDir,
  });

  const formattedOutput = await formatShellExecutionOutput({
    command: params.command,
    cwd: params.sshInfo?.remoteDir ?? process.cwd(),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    maxOutputLength,
    durationMs: Date.now() - startedAt,
  });

  return {
    text: formattedOutput.text,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  };
}
