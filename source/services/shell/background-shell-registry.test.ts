import { describe, expect, it } from 'vitest';
import {
  BackgroundShellRegistry,
  BackgroundShellRegistryCapacityError,
  BackgroundShellRegistryDisposedError,
} from './background-shell-registry.js';

describe('BackgroundShellRegistry', () => {
  it('starts a job with a registry-owned abort signal and retains its result', async () => {
    let receivedSignal: AbortSignal | undefined;
    const registry = new BackgroundShellRegistry<string>();

    const job = registry.launch({
      command: 'build',
      run: async (signal) => {
        receivedSignal = signal;
        return 'done';
      },
    });

    expect(job).toMatchObject({ command: 'build', status: 'running' });
    await job.settled;

    expect(receivedSignal).toBeDefined();
    expect(registry.get(job.id)).toMatchObject({ status: 'completed', result: 'done' });
  });

  it('cancels through the registry-owned controller and settles as cancelled', async () => {
    let release: (() => void) | undefined;
    let receivedSignal: AbortSignal | undefined;
    const registry = new BackgroundShellRegistry<string>();
    const job = registry.launch({
      command: 'watch',
      run: (signal) =>
        new Promise<string>((resolve) => {
          receivedSignal = signal;
          release = () => resolve('stopped');
        }),
    });

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(registry.cancel(job.id)).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);
    expect(registry.get(job.id)?.status).toBe('cancelling');

    release?.();
    await job.settled;
    expect(registry.get(job.id)).toMatchObject({ status: 'cancelled', result: 'stopped' });
  });

  it('runs settlement cleanup before publishing a terminal result', async () => {
    const events: string[] = [];
    const registry = new BackgroundShellRegistry<string>();
    const job = registry.launch({
      command: 'test',
      run: async () => {
        events.push('run');
        return 'ok';
      },
      onSettled: async () => {
        events.push('cleanup');
      },
    });

    await job.settled;

    expect(events).toEqual(['run', 'cleanup']);
    expect(registry.get(job.id)?.status).toBe('completed');
  });

  it('enforces the concurrent-job cap without evicting a running job', () => {
    const registry = new BackgroundShellRegistry<string>({ maxConcurrentJobs: 1 });
    const never = () => new Promise<string>(() => {});
    registry.launch({ command: 'one', run: never });

    expect(() => registry.launch({ command: 'two', run: never })).toThrow(BackgroundShellRegistryCapacityError);
  });

  it('evicts the oldest terminal result when retention is full', async () => {
    const registry = new BackgroundShellRegistry<string>({ maxRetainedJobs: 1 });
    const first = registry.launch({ command: 'first', run: async () => 'first-result' });
    await first.settled;
    const second = registry.launch({ command: 'second', run: async () => 'second-result' });
    await second.settled;

    expect(registry.get(first.id)).toBeUndefined();
    expect(registry.get(second.id)).toMatchObject({ status: 'completed', result: 'second-result' });
  });

  it('cancels outstanding jobs and rejects new work after disposal', async () => {
    let receivedSignal: AbortSignal | undefined;
    let resolve: (() => void) | undefined;
    const registry = new BackgroundShellRegistry<string>();
    registry.launch({
      command: 'watch',
      run: (signal) => {
        receivedSignal = signal;
        return new Promise<string>((resolvePromise) => {
          resolve = () => resolvePromise('cancelled');
          signal.addEventListener('abort', resolve, { once: true });
        });
      },
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const disposal = registry.dispose();
    expect(receivedSignal?.aborted).toBe(true);
    resolve?.();
    await disposal;

    expect(() => registry.launch({ command: 'new', run: async () => 'nope' })).toThrow(
      BackgroundShellRegistryDisposedError,
    );
  });

  it('emits one started and one settled snapshot for each job', async () => {
    const events: unknown[] = [];
    const registry = new BackgroundShellRegistry<string>({
      onEvent: (event) => events.push(event),
    });
    const job = registry.launch({ command: 'test', run: async () => 'ok' });

    await job.settled;

    expect(events).toEqual([
      { type: 'background_shell_started', jobId: job.id, command: 'test' },
      {
        type: 'background_shell_completed',
        jobId: job.id,
        command: 'test',
        status: 'completed',
        output: 'ok',
      },
    ]);
  });

  it('uses a launcher-provided terminal status for a completed timeout result', async () => {
    const registry = new BackgroundShellRegistry<{ timedOut: boolean }>({ createId: () => 'timed-job' });
    const job = registry.launch({
      command: 'slow',
      run: async () => ({ timedOut: true }),
      resultToStatus: (result) => (result.timedOut ? 'timed_out' : 'completed'),
    });

    await job.settled;

    expect(registry.get('timed-job')?.status).toBe('timed_out');
  });
});
