import test from 'ava';
import { executeShellCommand } from './execute-shell.js';

test('executeShellCommand returns stdout and exit code for successful command', async (t) => {
  const result = await executeShellCommand("printf 'hello'", {
    execImpl: async () => ({ stdout: 'hello', stderr: '' }),
  });

  t.is(result.stdout, 'hello');
  t.is(result.stderr, '');
  t.is(result.exitCode, 0);
  t.false(result.timedOut);
});

test('executeShellCommand captures stderr and exit code for failed command', async (t) => {
  const result = await executeShellCommand('fails', {
    execImpl: async () => {
      const error = new Error('failed') as Error & { code: number; stderr: string };
      error.code = 2;
      error.stderr = 'oops\n';
      throw error;
    },
  });

  t.is(result.stderr.trim(), 'oops');
  t.is(result.exitCode, 2);
  t.false(result.timedOut);
});

test('executeShellCommand reports timeouts', async (t) => {
  const result = await executeShellCommand('long-running', {
    timeout: 50,
    execImpl: async () => {
      const error = new Error('timeout') as Error & { signal: string };
      error.signal = 'SIGTERM';
      throw error;
    },
  });

  t.true(result.timedOut);
});
