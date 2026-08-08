import { spawn, type ChildProcess } from 'child_process';
import process from 'process';
import { SANDBOX_TEMP_DIR } from './temp-dir.js';
import { registerSandboxNetworkApprovalPauseController } from './sandbox/sandbox-network-approval.js';

/**
 * Process completion, output completion, and descendant cleanup are three
 * separate concerns, and none of them may wait indefinitely on another.
 *
 * The child's `'close'` event conflates the first two: Node emits it only once
 * the process has exited *and* every write end of its stdio pipes is closed.
 * Descendants inherit those pipes, so one surviving background process keeps
 * `'close'` from ever firing and the command hangs long after it finished.
 * `'exit'` reports only the direct child terminating, which is what "the
 * command is done" actually means, so that is what drives completion here.
 *
 * Output is then drained on a bounded deadline rather than to EOF. Once the
 * direct child has exited it cannot write anything more, so the grace period
 * only needs to cover bytes already sitting in kernel and Node buffers;
 * anything arriving later comes from an inherited writer we are not waiting
 * for. The bound is a policy, not a correctness guarantee — no finite grace
 * period can promise complete output while surviving descendants may still
 * write — so a truncated read is reported through `outputComplete` instead of
 * being silently indistinguishable from a clean one.
 */
const DEFAULT_DRAIN_GRACE_MS = 200;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;

// Sandbox network approvals identify the active command through one global
// pause controller. Keep the lease until process settlement, not merely command
// wrapping, so a concurrent sandboxed command cannot replace that controller.
let sandboxExecutionLeaseHeld = false;
const sandboxExecutionLeaseWaiters: Array<() => void> = [];

function withSandboxExecutionLease<T>(operation: () => Promise<T>): Promise<T> {
  const execute = (): Promise<T> => {
    sandboxExecutionLeaseHeld = true;
    return operation().finally(() => {
      const next = sandboxExecutionLeaseWaiters.shift();
      if (next) {
        next();
      } else {
        sandboxExecutionLeaseHeld = false;
      }
    });
  };

  if (!sandboxExecutionLeaseHeld) return execute();

  return new Promise<T>((resolve, reject) => {
    sandboxExecutionLeaseWaiters.push(() => {
      void execute().then(resolve, reject);
    });
  });
}

type ExecCallbackMeta = { outputComplete?: boolean };

type ExecCallback = (error: any, stdout: string | Buffer, stderr: string | Buffer, meta?: ExecCallbackMeta) => void;

type ExecOptions = {
  cwd?: string;
  maxBuffer?: number;
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
  drainGraceMs?: number;
  /**
   * Lets the caller force settlement with whatever output has arrived. An impl
   * that does not register one still gets bounded: the caller settles on its
   * own, just without partial output.
   */
  registerFinalizer?: (finalize: () => void) => void;
};

type ExecImpl = (command: string, options: ExecOptions, callback: ExecCallback) => ChildProcess;

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
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let stdoutAtEof = !child.stdout;
  let stderrAtEof = !child.stderr;
  let drainTimer: NodeJS.Timeout | undefined;
  let finished = false;

  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  const drainGraceMs = options.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
  const streamsAtEof = () => stdoutAtEof && stderrAtEof;

  const releaseStreams = () => {
    child.stdout?.destroy();
    child.stderr?.destroy();
  };

  const finish = (outputComplete: boolean) => {
    if (finished) return;
    finished = true;
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }
    const meta: ExecCallbackMeta = { outputComplete };
    if (ex) {
      callback(ex, stdout, stderr, meta);
      return;
    }
    if (exitCode !== 0 || exitSignal) {
      const err = new Error(`Command failed: ${command}`) as any;
      err.code = exitCode;
      err.signal = exitSignal;
      callback(err, stdout, stderr, meta);
      return;
    }
    callback(null, stdout, stderr, meta);
  };

  const beginBoundedDrain = () => {
    if (streamsAtEof()) {
      finish(true);
      return;
    }
    if (drainTimer) return;
    drainTimer = setTimeout(() => {
      drainTimer = undefined;
      releaseStreams();
      finish(false);
    }, drainGraceMs);
  };

  const markEof = (which: 'stdout' | 'stderr') => {
    if (which === 'stdout') stdoutAtEof = true;
    else stderrAtEof = true;
    if (exited) beginBoundedDrain();
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > maxBuffer) {
      ex ??= new Error('stdout maxBuffer length exceeded');
      stopChildProcess(child);
    }
  });
  child.stdout?.on('end', () => markEof('stdout'));
  child.stdout?.on('close', () => markEof('stdout'));

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > maxBuffer) {
      ex ??= new Error('stderr maxBuffer length exceeded');
      stopChildProcess(child);
    }
  });
  child.stderr?.on('end', () => markEof('stderr'));
  child.stderr?.on('close', () => markEof('stderr'));

  child.on('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
    beginBoundedDrain();
  });

  child.on('error', (err) => {
    ex ??= err;
    // A failed spawn emits 'error' without ever emitting 'exit', so completion
    // has to come from here or the command would never settle.
    if (!exited) {
      releaseStreams();
      finish(streamsAtEof());
    }
  });

  options.registerFinalizer?.(() => {
    releaseStreams();
    finish(streamsAtEof());
  });

  return child;
};

export interface ShellExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** The signal that terminated the command, when one did. */
  signal?: NodeJS.Signals | null;
  /** False when output was cut short at the drain deadline rather than at EOF. */
  outputComplete?: boolean;
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
  /** How long to keep reading output after the child exits. */
  drainGraceMs?: number;
  /** How long SIGTERM gets before SIGKILL follows. */
  terminationGraceMs?: number;
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
  if (options.pauseOnSandboxNetworkApproval && !options.sshService) {
    return await withSandboxExecutionLease(() => executeShellCommandUnleased(command, options));
  }

  return await executeShellCommandUnleased(command, options);
}

async function executeShellCommandUnleased(
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
    drainGraceMs = DEFAULT_DRAIN_GRACE_MS,
    terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  } = options;

  if (sshService) {
    return sshService.executeCommand(command, { cwd });
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...(env ?? process.env),
    TMPDIR: SANDBOX_TEMP_DIR,
  };

  // Latched the moment the deadline fires. A command that is killed and then
  // happens to exit 0 is still a timeout, so this is never cleared.
  let timedOutLatched = false;
  let outputCompleteResult: boolean | undefined;

  try {
    const result = await new Promise<{ stdout?: string | Buffer; stderr?: string | Buffer }>((resolve, reject) => {
      let unregisterPauseController: (() => void) | undefined;
      let timeoutId: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let hardFinishTimer: NodeJS.Timeout | undefined;
      let timeoutStartedAt: number | undefined;
      let remainingTimeoutMs = timeout ?? 0;
      let paused = false;
      let settled = false;
      let finalizeImpl: (() => void) | undefined;

      const clearCommandTimeout = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        timeoutStartedAt = undefined;
      };
      const clearTerminationTimers = () => {
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = undefined;
        }
        if (hardFinishTimer) {
          clearTimeout(hardFinishTimer);
          hardFinishTimer = undefined;
        }
      };
      /**
       * Killing is cleanup, not the mechanism that bounds the command. Group
       * signalling misses any descendant that started its own session, so the
       * only real guarantee is that this settles on a deadline regardless of
       * whether anything actually died.
       */
      const beginTermination = () => {
        if (settled || hardFinishTimer) return;
        if (paused) {
          paused = false;
          signalChildProcess(child, 'SIGCONT');
        }
        stopChildProcess(child);
        killTimer = setTimeout(() => {
          killTimer = undefined;
          signalChildProcess(child, 'SIGKILL');
        }, terminationGraceMs);
        hardFinishTimer = setTimeout(() => {
          hardFinishTimer = undefined;
          // Settle with whatever the impl has buffered, then unconditionally.
          finalizeImpl?.();
          if (!settled) {
            settled = true;
            cleanupListeners();
            outputCompleteResult = false;
            resolve({ stdout: '', stderr: '' });
          }
        }, terminationGraceMs + drainGraceMs);
      };
      const stopChild = () => beginTermination();
      const cleanupListeners = () => {
        clearCommandTimeout();
        clearTerminationTimers();
        signal?.removeEventListener('abort', stopChild);
        unregisterPauseController?.();
      };
      const startCommandTimeout = () => {
        if (remainingTimeoutMs <= 0 || timeoutId) return;
        timeoutStartedAt = Date.now();
        timeoutId = setTimeout(() => {
          timeoutId = undefined;
          remainingTimeoutMs = 0;
          timedOutLatched = true;
          beginTermination();
        }, remainingTimeoutMs);
      };
      const pauseCommandTimeout = () => {
        if (!timeoutId || timeoutStartedAt === undefined) return;
        remainingTimeoutMs = Math.max(0, remainingTimeoutMs - (Date.now() - timeoutStartedAt));
        clearCommandTimeout();
      };

      const child = execImpl(
        command,
        {
          cwd,
          maxBuffer,
          env: childEnv,
          detached: process.platform !== 'win32',
          drainGraceMs,
          registerFinalizer: (finalize) => {
            finalizeImpl = finalize;
          },
        },
        (error, stdout, stderr, meta) => {
          if (settled) return;
          settled = true;
          cleanupListeners();
          outputCompleteResult = meta?.outputComplete ?? true;
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
      timedOut: timedOutLatched,
      signal: null,
      outputComplete: outputCompleteResult ?? true,
    };
  } catch (error: any) {
    const exitCode = typeof error?.code === 'number' ? error.code : null;
    const signal = (error?.signal as NodeJS.Signals | null | undefined) ?? null;
    // The latch is authoritative; the signal check stays as a fallback for
    // impls that terminate the child without going through the deadline.
    const timedOut = timedOutLatched || Boolean(error?.killed || error?.signal === 'SIGTERM');

    return {
      stdout: error?.stdout?.toString() ?? '',
      stderr: error?.stderr?.toString() ?? '',
      exitCode,
      timedOut,
      signal,
      outputComplete: outputCompleteResult ?? true,
    };
  }
}
