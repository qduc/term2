import { exec, type ChildProcess } from 'child_process';
import process from 'process';

type ExecCallback = (error: any, stdout: string | Buffer, stderr: string | Buffer) => void;

type ExecImpl = (
  command: string,
  options: { cwd?: string; timeout?: number; maxBuffer?: number; detached?: boolean },
  callback: ExecCallback,
) => ChildProcess;

const defaultExecImpl: ExecImpl = exec;

export interface ShellExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

import { ISSHService } from '../../services/service-interfaces.js';

export interface ExecuteShellOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  sshService?: ISSHService;
  execImpl?: ExecImpl;
}

function stopChildProcess(child: ChildProcess): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch {
      // Fall back to killing the direct child when it has no usable process group.
    }
  }

  child.kill('SIGTERM');
}

export async function executeShellCommand(
  command: string,
  options: ExecuteShellOptions = {},
): Promise<ShellExecutionResult> {
  const { cwd = process.cwd(), timeout, maxBuffer, signal, sshService, execImpl = defaultExecImpl } = options;

  if (sshService) {
    return sshService.executeCommand(command, { cwd });
  }

  try {
    const result = await new Promise<{ stdout?: string | Buffer; stderr?: string | Buffer }>((resolve, reject) => {
      const child = execImpl(
        command,
        {
          cwd,
          timeout,
          maxBuffer,
          detached: process.platform !== 'win32',
        },
        (error, stdout, stderr) => {
          signal?.removeEventListener('abort', stopChild);
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
            return;
          }

          resolve({ stdout, stderr });
        },
      );

      const stopChild = () => stopChildProcess(child);
      if (signal?.aborted) {
        stopChild();
      } else {
        signal?.addEventListener('abort', stopChild, { once: true });
      }

      child.stdin?.end();
    });

    return {
      stdout: result.stdout?.toString() ?? '',
      stderr: result.stderr?.toString() ?? '',
      exitCode: 0,
      timedOut: false,
    };
  } catch (error: any) {
    const exitCode = typeof error?.code === 'number' ? error.code : null;
    const timedOut = Boolean(error?.killed || error?.signal === 'SIGTERM');

    return {
      stdout: error?.stdout?.toString() ?? '',
      stderr: error?.stderr?.toString() ?? '',
      exitCode,
      timedOut,
    };
  }
}
