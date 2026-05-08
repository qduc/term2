import { exec } from 'child_process';
import util from 'util';
import process from 'process';

type ExecPromise = (
  command: string,
  options: { cwd?: string; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout?: string; stderr?: string }>;

const defaultExecPromise: ExecPromise = util.promisify(exec);

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
  execImpl?: ExecPromise;
}

export async function executeShellCommand(
  command: string,
  options: ExecuteShellOptions = {},
): Promise<ShellExecutionResult> {
  const { cwd = process.cwd(), timeout, maxBuffer, sshService, execImpl = defaultExecPromise } = options;

  if (sshService) {
    return sshService.executeCommand(command, { cwd });
  }

  try {
    const result = await execImpl(command, {
      cwd,
      timeout,
      maxBuffer,
    });

    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: 0,
      timedOut: false,
    };
  } catch (error: any) {
    const exitCode = typeof error?.code === 'number' ? error.code : null;
    const timedOut = Boolean(error?.killed || error?.signal === 'SIGTERM');

    return {
      stdout: error?.stdout ?? '',
      stderr: error?.stderr ?? '',
      exitCode,
      timedOut,
    };
  }
}
