import { it, expect } from 'vitest';
import { PassThrough, Writable } from 'stream';
import type { ChildProcess } from 'child_process';
import { executeShellCommand } from './execute-shell.js';
import { SANDBOX_TEMP_DIR } from './temp-dir.js';
import {
  registerSandboxNetworkApprovalHandler,
  requestSandboxNetworkApproval,
} from './sandbox/sandbox-network-approval.js';

it('executeShellCommand returns stdout and exit code for successful command', async () => {
  const result = await executeShellCommand("printf 'hello'", {
    execImpl: (_command, _options, callback) => {
      queueMicrotask(() => callback(null, 'hello', ''));
      return createFakeChildProcess();
    },
  });

  expect(result.stdout).toBe('hello');
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(0);
  expect(result.timedOut).toBe(false);
});

it('executeShellCommand captures stderr and exit code for failed command', async () => {
  const result = await executeShellCommand('fails', {
    execImpl: (_command, _options, callback) => {
      const error = new Error('failed') as Error & { code: number; stderr: string };
      error.code = 2;
      queueMicrotask(() => callback(error, '', 'oops\n'));
      return createFakeChildProcess();
    },
  });

  expect(result.stderr.trim()).toBe('oops');
  expect(result.exitCode).toBe(2);
  expect(result.timedOut).toBe(false);
});

it('executeShellCommand reports timeouts', async () => {
  const result = await executeShellCommand('long-running', {
    timeout: 50,
    execImpl: (_command, _options, callback) => {
      const error = new Error('timeout') as Error & { signal: string };
      error.signal = 'SIGTERM';
      queueMicrotask(() => callback(error, '', ''));
      return createFakeChildProcess();
    },
  });

  expect(result.timedOut).toBe(true);
});

it('executeShellCommand merges env for exec implementation and sets TMPDIR', async () => {
  let receivedEnv: NodeJS.ProcessEnv | undefined;
  const env = { PATH: '/bin', TERM: 'xterm-256color' };

  const result = await executeShellCommand('uses-env', {
    env,
    execImpl: (_command, options, callback) => {
      receivedEnv = options.env;
      queueMicrotask(() => callback(null, 'ok', ''));
      return createFakeChildProcess();
    },
  });

  expect(result.exitCode).toBe(0);
  expect(receivedEnv).toMatchObject(env);
  expect(receivedEnv?.TMPDIR).toBe(SANDBOX_TEMP_DIR);
});

it('executeShellCommand sets TMPDIR when env is omitted', async () => {
  let receivedEnv: NodeJS.ProcessEnv | undefined;

  const result = await executeShellCommand('uses-default-env', {
    execImpl: (_command, options, callback) => {
      receivedEnv = options.env;
      queueMicrotask(() => callback(null, 'ok', ''));
      return createFakeChildProcess();
    },
  });

  expect(result.exitCode).toBe(0);
  expect(receivedEnv?.TMPDIR).toBe(SANDBOX_TEMP_DIR);
});

it('executeShellCommand closes child stdin immediately', async () => {
  let stdinEnded = false;

  const result = await executeShellCommand('waits-for-stdin', {
    execImpl: (_command, _options, callback) => {
      const child = createFakeChildProcess();
      child.stdin = new Writable({
        write(_chunk, _encoding, next) {
          next();
        },
        final(next) {
          stdinEnded = true;
          queueMicrotask(() => callback(null, '', ''));
          next();
        },
      });

      return child;
    },
  });

  expect(stdinEnded).toBe(true);
  expect(result.exitCode).toBe(0);
});

it('executeShellCommand stops the child process when execution is aborted', async () => {
  const abortController = new AbortController();
  let killCalls = 0;

  const resultPromise = executeShellCommand('long-running', {
    signal: abortController.signal,
    execImpl: (_command, _options, callback) => {
      const child = createFakeChildProcess();
      child.kill = () => {
        killCalls += 1;
        const error = new Error('aborted') as Error & { signal: string };
        error.signal = 'SIGTERM';
        queueMicrotask(() => callback(error, '', ''));
        return true;
      };
      return child;
    },
  });

  abortController.abort();
  const result = await resultPromise;

  expect(killCalls).toBe(1);
  expect(result.timedOut).toBe(true);
});

it('executeShellCommand pauses sandboxed child processes while network approval is pending', async () => {
  let completeCommand: ((stdout: string) => void) | undefined;
  let resolveApproval: ((allow: boolean) => void) | undefined;
  const signals: string[] = [];
  const unregisterHandler = registerSandboxNetworkApprovalHandler(async () => {
    return await new Promise<boolean>((resolve) => {
      resolveApproval = resolve;
    });
  });

  const resultPromise = executeShellCommand('networking', {
    pauseOnSandboxNetworkApproval: true,
    execImpl: (_command, _options, callback) => {
      const child = createFakeChildProcess();
      child.kill = (signal?: NodeJS.Signals | number) => {
        signals.push(String(signal));
        return true;
      };
      completeCommand = (stdout) => callback(null, stdout, '');
      return child;
    },
  });

  const approvalPromise = requestSandboxNetworkApproval({ host: 'example.com', port: 443 });
  await Promise.resolve();
  await Promise.resolve();

  expect(signals).toEqual(['SIGSTOP']);

  resolveApproval?.(true);
  await expect(approvalPromise).resolves.toBe(true);
  expect(signals).toEqual(['SIGSTOP', 'SIGCONT']);

  completeCommand?.('ok');
  await expect(resultPromise).resolves.toMatchObject({ stdout: 'ok', exitCode: 0 });

  unregisterHandler();
});

function createFakeChildProcess(): ChildProcess {
  return {
    stdin: new PassThrough(),
  } as unknown as ChildProcess;
}
