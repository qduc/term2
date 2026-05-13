import { exec, type ChildProcess } from 'child_process';
import process from 'process';

type ExecCallback = (error: any, stdout: string | Buffer, stderr: string | Buffer) => void;

type ExecImpl = (
  command: string,
  options: { cwd?: string; timeout?: number; maxBuffer?: number },
  callback: ExecCallback,
) => ChildProcess;

const defaultExecImpl: ExecImpl = exec;

export interface ShellExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

import { ISSHService } from '../services/service-interfaces.js';

export interface ExecuteShellOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  sshService?: ISSHService;
  execImpl?: ExecImpl;
}

export async function executeShellCommand(
  command: string,
  options: ExecuteShellOptions = {},
): Promise<ShellExecutionResult> {
  const { cwd = process.cwd(), timeout, maxBuffer, sshService, execImpl = defaultExecImpl } = options;

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
        },
        (error, stdout, stderr) => {
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
            return;
          }

          resolve({ stdout, stderr });
        },
      );

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
