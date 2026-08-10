import { describe, it, expect } from 'vitest';
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
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(signals).toEqual(['SIGSTOP']);

  resolveApproval?.(true);
  await expect(approvalPromise).resolves.toBe(true);
  expect(signals).toEqual(['SIGSTOP', 'SIGCONT']);

  completeCommand?.('ok');
  await expect(resultPromise).resolves.toMatchObject({ stdout: 'ok', exitCode: 0 });

  unregisterHandler();
});

it('serializes sandboxed executions so network approval pauses the owning child', async () => {
  const completions = new Map<string, (stdout: string) => void>();
  const started: string[] = [];
  const signals: string[] = [];
  let resolveApproval: ((allow: boolean) => void) | undefined;
  const unregisterHandler = registerSandboxNetworkApprovalHandler(async () => {
    return await new Promise<boolean>((resolve) => {
      resolveApproval = resolve;
    });
  });
  const makeExecution = (command: string) =>
    executeShellCommand(command, {
      pauseOnSandboxNetworkApproval: true,
      execImpl: (receivedCommand, _options, callback) => {
        started.push(receivedCommand);
        const child = createFakeChildProcess();
        child.kill = (signal?: NodeJS.Signals | number) => {
          signals.push(`${receivedCommand}:${String(signal)}`);
          return true;
        };
        completions.set(receivedCommand, (stdout) => callback(null, stdout, ''));
        return child;
      },
    });

  const first = makeExecution('first');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = makeExecution('second');
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(started).toEqual(['first']);

  const firstApproval = requestSandboxNetworkApproval({ host: 'first.example', port: 443 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(signals).toEqual(['first:SIGSTOP']);

  resolveApproval?.(true);
  await expect(firstApproval).resolves.toBe(true);
  completions.get('first')?.('first complete');
  await expect(first).resolves.toMatchObject({ stdout: 'first complete', exitCode: 0 });

  expect(started).toEqual(['first', 'second']);

  const secondApproval = requestSandboxNetworkApproval({ host: 'second.example', port: 443 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(signals).toEqual(['first:SIGSTOP', 'first:SIGCONT', 'second:SIGSTOP']);

  resolveApproval?.(true);
  await expect(secondApproval).resolves.toBe(true);
  completions.get('second')?.('second complete');
  await expect(second).resolves.toMatchObject({ stdout: 'second complete', exitCode: 0 });

  unregisterHandler();
});

// The chunk tap and the overflow policy live in defaultExecImpl, which spawns
// real children, so these run real processes — the same convention as
// execute-shell.orphan-bound.test.ts. Each write is time-separated so the
// child's separate write() calls cannot coalesce into one pipe chunk.
describe.skipIf(process.platform === 'win32')('executeShellCommand chunk tap and overflow', () => {
  const nodeEval = (program: string) => `node -e "${program}"`;

  it('delivers each chunk as it arrives, per stream, in arrival order', async () => {
    const chunks: Array<['stdout' | 'stderr', string]> = [];

    const result = await executeShellCommand(
      nodeEval(
        `process.stdout.write('a'); setTimeout(() => process.stderr.write('b'), 30); setTimeout(() => process.stdout.write('c'), 60)`,
      ),
      { timeout: 10_000, onOutputChunk: (stream, text) => chunks.push([stream, text]) },
    );

    expect(chunks).toEqual([
      ['stdout', 'a'],
      ['stderr', 'b'],
      ['stdout', 'c'],
    ]);
    expect(result.stdout).toBe('ac');
    expect(result.stderr).toBe('b');
  });

  it('delivers a line split across two chunks as two raw chunks, in order', async () => {
    const texts: string[] = [];

    const result = await executeShellCommand(
      nodeEval(`process.stdout.write('hel'); setTimeout(() => process.stdout.write('lo\\n'), 30)`),
      { timeout: 10_000, onOutputChunk: (_stream, text) => texts.push(text) },
    );

    expect(texts).toEqual(['hel', 'lo\n']);
    expect(result.stdout).toBe('hello\n');
  });

  it('truncate overflow keeps the child running and retains the tail of the output', async () => {
    const result = await executeShellCommand(
      nodeEval(`process.stdout.write('x'.repeat(3000)); setTimeout(() => process.stdout.write('END'), 30)`),
      { timeout: 10_000, maxBuffer: 1024, overflow: 'truncate' },
    );

    // The post-flood write landed, which is only possible if the flood did not
    // kill the child, and the retained text is the last 1024 bytes.
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('x'.repeat(1021) + 'END');
  });

  it('default kill overflow still kills the child and hands back the untrimmed buffer', async () => {
    const result = await executeShellCommand(
      nodeEval(`process.stdout.write('x'.repeat(3000)); setTimeout(() => process.stdout.write('END'), 30)`),
      { timeout: 10_000, maxBuffer: 1024 },
    );

    // The child was killed before the post-flood write could land, and the
    // accumulated buffer is handed back untrimmed.
    expect(result.stdout).toBe('x'.repeat(3000));
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeNull();
  });
});

function createFakeChildProcess(): ChildProcess {
  return {
    stdin: new PassThrough(),
  } as unknown as ChildProcess;
}
