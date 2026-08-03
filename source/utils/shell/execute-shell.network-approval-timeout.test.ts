import { EventEmitter } from 'events';
import process from 'process';
import { PassThrough } from 'stream';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import { executeShellCommand } from './execute-shell.js';
import {
  registerSandboxNetworkApprovalHandler,
  registerSandboxNetworkApprovalPauseController,
  requestSandboxNetworkApproval,
} from './sandbox/sandbox-network-approval.js';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

const spawnMock = vi.mocked(spawn);

afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
  registerSandboxNetworkApprovalHandler(null);
  registerSandboxNetworkApprovalPauseController(null);
});

it('excludes sandbox network approval wait time from the shell timeout', async () => {
  vi.useFakeTimers();
  const child = createPausedChild();
  spawnMock.mockReturnValue(child as any);

  let resolveApproval: ((allow: boolean) => void) | undefined;
  registerSandboxNetworkApprovalHandler(
    async () =>
      new Promise<boolean>((resolve) => {
        resolveApproval = resolve;
      }),
  );

  const command = executeShellCommand('networking', {
    timeout: 10,
    pauseOnSandboxNetworkApproval: true,
  });
  const approval = requestSandboxNetworkApproval({ host: 'example.com', port: 443 });
  await Promise.resolve();
  await Promise.resolve();

  vi.advanceTimersByTime(50);

  expect(child.signals).not.toContain('SIGTERM');

  resolveApproval?.(true);
  await expect(approval).resolves.toBe(true);
  child.complete();

  await expect(command).resolves.toMatchObject({ exitCode: 0, timedOut: false });
});

it('resumes the remaining timeout budget after network approval', async () => {
  vi.useFakeTimers();
  const child = createPausedChild();
  spawnMock.mockReturnValue(child as any);

  let resolveApproval: ((allow: boolean) => void) | undefined;
  registerSandboxNetworkApprovalHandler(
    async () =>
      new Promise<boolean>((resolve) => {
        resolveApproval = resolve;
      }),
  );

  const command = executeShellCommand('networking', {
    timeout: 10,
    pauseOnSandboxNetworkApproval: true,
  });
  vi.advanceTimersByTime(3);
  const approval = requestSandboxNetworkApproval({ host: 'example.com', port: 443 });
  await Promise.resolve();
  await Promise.resolve();
  vi.advanceTimersByTime(50);

  resolveApproval?.(true);
  await expect(approval).resolves.toBe(true);

  vi.advanceTimersByTime(6);
  expect(child.signals).not.toContain('SIGTERM');

  vi.advanceTimersByTime(1);
  expect(child.signals).toContain('SIGTERM');
  await expect(command).resolves.toMatchObject({ timedOut: true });
});

it('resumes a paused child before terminating it on abort', async () => {
  const abortController = new AbortController();
  const child = createPausedChild();
  spawnMock.mockReturnValue(child as any);

  let resolveApproval: ((allow: boolean) => void) | undefined;
  registerSandboxNetworkApprovalHandler(
    async () =>
      new Promise<boolean>((resolve) => {
        resolveApproval = resolve;
      }),
  );

  const command = executeShellCommand('networking', {
    signal: abortController.signal,
    pauseOnSandboxNetworkApproval: true,
  });
  const approval = requestSandboxNetworkApproval({ host: 'example.com', port: 443 });
  await Promise.resolve();
  await Promise.resolve();

  abortController.abort();

  expect(child.signals).toContain('SIGTERM');
  if (process.platform !== 'win32') {
    expect(child.signals.indexOf('SIGCONT')).toBeLessThan(child.signals.indexOf('SIGTERM'));
  }
  await expect(command).resolves.toMatchObject({ timedOut: true });

  resolveApproval?.(false);
  await expect(approval).resolves.toBe(false);
});

it('does not register a pause controller after a synchronous execution callback', async () => {
  const child = createPausedChild();
  await expect(
    executeShellCommand('synchronous', {
      pauseOnSandboxNetworkApproval: true,
      execImpl: (_command, _options, callback) => {
        callback(null, 'ok', '');
        return child as any;
      },
    }),
  ).resolves.toMatchObject({ stdout: 'ok', exitCode: 0 });

  const unregister = registerSandboxNetworkApprovalHandler(async () => true);
  await expect(requestSandboxNetworkApproval({ host: 'example.com', port: 443 })).resolves.toBe(true);

  expect(child.signals).toEqual([]);
  unregister();
});

it('stops an unpaused command when its allotted execution time elapses', async () => {
  vi.useFakeTimers();
  const child = createPausedChild();
  spawnMock.mockReturnValue(child as any);

  const command = executeShellCommand('long-running', { timeout: 10 });
  vi.advanceTimersByTime(10);

  expect(child.signals).toEqual(['SIGTERM']);
  await expect(command).resolves.toMatchObject({ timedOut: true });
});

function createPausedChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: NodeJS.Signals | number) => boolean;
    signals: string[];
    complete: () => void;
  };
  let paused = false;
  let terminationPending = false;

  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];

  // Model the real child lifecycle: an exiting process closes its pipes and
  // emits 'exit' before 'close'. Emitting only 'close' would let a fake pass
  // where a real process whose pipes are held open by a descendant would not.
  const settle = (code: number | null, signal: NodeJS.Signals | null) => {
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };

  child.kill = (signal) => {
    child.signals.push(String(signal));
    if (signal === 'SIGSTOP') paused = true;
    if (signal === 'SIGTERM') {
      terminationPending = true;
      if (!paused) settle(null, 'SIGTERM');
    }
    if (signal === 'SIGCONT') {
      paused = false;
      if (terminationPending) settle(null, 'SIGTERM');
    }
    return true;
  };
  child.complete = () => settle(0, null);

  return child;
}
