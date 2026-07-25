import { spawn, type ChildProcess } from 'child_process';
import process from 'process';
import { SANDBOX_TEMP_DIR } from './temp-dir.js';
import { registerSandboxNetworkApprovalPauseController } from './sandbox/sandbox-network-approval.js';

type ExecCallback = (error: any, stdout: string | Buffer, stderr: string | Buffer) => void;

type ExecImpl = (
  command: string,
  options: { cwd?: string; maxBuffer?: number; detached?: boolean; env?: NodeJS.ProcessEnv },
  callback: ExecCallback,
) => ChildProcess;

const defaultExecImpl: ExecImpl = (command, options, callback) => {
  const child = spawn(command, {
    shell: true,
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
  });

  let stdout = '';
  let stderr = '';
  let ex: Error | null = null;
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > maxBuffer) {
      ex = new Error('stdout maxBuffer length exceeded');
      child.kill('SIGTERM');
    }
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > maxBuffer) {
      ex = new Error('stderr maxBuffer length exceeded');
      child.kill('SIGTERM');
    }
  });

  child.on('close', (code, signal) => {
    if (ex) {
      callback(ex, stdout, stderr);
      return;
    }
    if (code !== 0 || signal) {
      const err = new Error(`Command failed: ${command}`) as any;
      err.code = code;
      err.signal = signal;
      callback(err, stdout, stderr);
      return;
    }
    callback(null, stdout, stderr);
  });

  child.on('error', (err) => {
    if (!ex) {
      ex = err;
    }
  });

  return child;
};

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
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  sshService?: ISSHService;
  execImpl?: ExecImpl;
  pauseOnSandboxNetworkApproval?: boolean;
}

function signalChildProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    return;
  }

  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when it has no usable process group.
    }
  }

  child.kill(signal);
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
  const {
    cwd = process.cwd(),
    timeout,
    maxBuffer,
    env,
    signal,
    sshService,
    execImpl = defaultExecImpl,
    pauseOnSandboxNetworkApproval = false,
  } = options;

  if (sshService) {
    return sshService.executeCommand(command, { cwd });
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...(env ?? process.env),
    TMPDIR: SANDBOX_TEMP_DIR,
  };

  try {
    const result = await new Promise<{ stdout?: string | Buffer; stderr?: string | Buffer }>((resolve, reject) => {
      let unregisterPauseController: (() => void) | undefined;
      let timeoutId: NodeJS.Timeout | undefined;
      let timeoutStartedAt: number | undefined;
      let remainingTimeoutMs = timeout ?? 0;
      let child: ChildProcess;
      let paused = false;
      let settled = false;

      const clearCommandTimeout = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        timeoutStartedAt = undefined;
      };
      const stopChild = () => {
        if (paused) {
          paused = false;
          signalChildProcess(child, 'SIGCONT');
        }
        stopChildProcess(child);
      };
      const startCommandTimeout = () => {
        if (remainingTimeoutMs <= 0 || timeoutId) return;
        timeoutStartedAt = Date.now();
        timeoutId = setTimeout(() => {
          timeoutId = undefined;
          remainingTimeoutMs = 0;
          stopChild();
        }, remainingTimeoutMs);
      };
      const pauseCommandTimeout = () => {
        if (!timeoutId || timeoutStartedAt === undefined) return;
        remainingTimeoutMs = Math.max(0, remainingTimeoutMs - (Date.now() - timeoutStartedAt));
        clearCommandTimeout();
      };

      child = execImpl(
        command,
        {
          cwd,
          maxBuffer,
          env: childEnv,
          detached: process.platform !== 'win32',
        },
        (error, stdout, stderr) => {
          if (settled) return;
          settled = true;
          clearCommandTimeout();
          signal?.removeEventListener('abort', stopChild);
          unregisterPauseController?.();
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
            return;
          }

          resolve({ stdout, stderr });
        },
      );

      if (!settled) {
        startCommandTimeout();
        if (pauseOnSandboxNetworkApproval) {
          unregisterPauseController = registerSandboxNetworkApprovalPauseController({
            pause: () => {
              if (settled || paused) return;
              pauseCommandTimeout();
              paused = true;
              signalChildProcess(child, 'SIGSTOP');
            },
            resume: () => {
              if (settled || !paused) return;
              paused = false;
              startCommandTimeout();
              signalChildProcess(child, 'SIGCONT');
            },
          });
        }
        if (signal?.aborted) {
          stopChild();
        } else {
          signal?.addEventListener('abort', stopChild, { once: true });
        }

        child.stdin?.end();
      }
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
