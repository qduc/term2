import test from 'ava';
import { PassThrough, Writable } from 'stream';
import type { ChildProcess } from 'child_process';
import { executeShellCommand } from './execute-shell.js';

test('executeShellCommand returns stdout and exit code for successful command', async (t) => {
  const result = await executeShellCommand("printf 'hello'", {
    execImpl: (_command, _options, callback) => {
      queueMicrotask(() => callback(null, 'hello', ''));
      return createFakeChildProcess();
    },
  });

  t.is(result.stdout, 'hello');
  t.is(result.stderr, '');
  t.is(result.exitCode, 0);
  t.false(result.timedOut);
});

test('executeShellCommand captures stderr and exit code for failed command', async (t) => {
  const result = await executeShellCommand('fails', {
    execImpl: (_command, _options, callback) => {
      const error = new Error('failed') as Error & { code: number; stderr: string };
      error.code = 2;
      queueMicrotask(() => callback(error, '', 'oops\n'));
      return createFakeChildProcess();
    },
  });

  t.is(result.stderr.trim(), 'oops');
  t.is(result.exitCode, 2);
  t.false(result.timedOut);
});

test('executeShellCommand reports timeouts', async (t) => {
  const result = await executeShellCommand('long-running', {
    timeout: 50,
    execImpl: (_command, _options, callback) => {
      const error = new Error('timeout') as Error & { signal: string };
      error.signal = 'SIGTERM';
      queueMicrotask(() => callback(error, '', ''));
      return createFakeChildProcess();
    },
  });

  t.true(result.timedOut);
});

test('executeShellCommand closes child stdin immediately', async (t) => {
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

  t.true(stdinEnded);
  t.is(result.exitCode, 0);
});

function createFakeChildProcess(): ChildProcess {
  return {
    stdin: new PassThrough(),
  } as unknown as ChildProcess;
}
