import { it, expect } from 'vitest';
import { PassThrough, Writable } from 'stream';
import type { ChildProcess } from 'child_process';
import { executeShellCommand } from './execute-shell.js';

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

function createFakeChildProcess(): ChildProcess {
  return {
    stdin: new PassThrough(),
  } as unknown as ChildProcess;
}
