import { describe, expect, it, vi } from 'vitest';
import {
  BackgroundShellRegistry,
  BackgroundShellRegistryCapacityError,
  BackgroundShellRegistryDisposedError,
} from './background-shell-registry.js';

describe('BackgroundShellRegistry', () => {
  it('records output activity timestamps without retaining output chunks', async () => {
    let now = 1_000;
    const registry = new BackgroundShellRegistry<string>({ now: () => now });
    const job = registry.launch({ command: 'watch', run: () => new Promise<string>(() => undefined) });

    expect(registry.get(job.id)).toMatchObject({
      lastActivityAt: 1_000,
      lastObservation: { kind: 'shell_started', at: 1_000 },
    });
    now = 2_500;
    registry.recordOutputChunk(job.id);
    expect(registry.get(job.id)).toMatchObject({
      lastActivityAt: 2_500,
      lastObservation: { kind: 'shell_output_received', at: 2_500 },
    });
    expect(registry.get(job.id)).not.toHaveProperty('outputChunk');
    expect(registry.cancel(job.id)).toBe(true);
    registry.dispose();
    vi.restoreAllMocks();
  });

  it('publishes the job id before a synchronous runner output callback', () => {
    let startedJobId: string | undefined;
    let outputRecorded = false;
    const registry = new BackgroundShellRegistry<string>({ createId: () => 'early-output-job' });

    const job = registry.launch({
      command: 'printf early',
      onStarted: (jobId) => {
        startedJobId = jobId;
      },
      run: async () => {
        outputRecorded = registry.recordOutputChunk(startedJobId ?? '');
        return 'done';
      },
    });

    expect(startedJobId).toBe(job.id);
    expect(outputRecorded).toBe(true);
    registry.dispose();
  });

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
    expect(registry.get(job.id)?.lastObservation).toMatchObject({ kind: 'stop_requested' });
    expect(registry.recordOutputChunk(job.id)).toBe(true);
    expect(registry.get(job.id)?.lastObservation).toMatchObject({ kind: 'stop_requested' });

    release?.();
    await job.settled;
    expect(registry.get(job.id)).toMatchObject({
      status: 'cancelled',
      result: 'stopped',
      lastObservation: { kind: 'settled' },
    });
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

  it('adopts an already-running foreground lease without restarting it', async () => {
    let release: (() => void) | undefined;
    let executions = 0;
    let cleanups = 0;
    const events: unknown[] = [];
    const registry = new BackgroundShellRegistry<string>({
      createId: () => 'adopted-job',
      now: () => 123,
      onEvent: (event) => events.push(event),
    });
    const lease = registry.startForeground({
      callId: 'call-foreground',
      command: 'long-running-command',
      run: () =>
        new Promise<string>((resolve) => {
          executions += 1;
          release = () => resolve('done');
        }),
      onSettled: () => {
        cleanups += 1;
      },
    });

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const adopted = registry.adoptForeground('call-foreground');

    expect(adopted).toEqual({ jobId: 'adopted-job', status: 'running' });
    expect(registry.getForeground('call-foreground')).toBeUndefined();
    expect(registry.get('adopted-job')).toMatchObject({
      id: 'adopted-job',
      command: 'long-running-command',
      status: 'running',
      startedAt: 123,
    });
    expect(await lease.foregroundResult).toEqual(adopted);
    expect(executions).toBe(1);

    release?.();
    await lease.settled;

    expect(cleanups).toBe(1);
    expect(events).toEqual([
      { type: 'background_shell_started', jobId: 'adopted-job', command: 'long-running-command' },
      {
        type: 'background_shell_completed',
        jobId: 'adopted-job',
        command: 'long-running-command',
        status: 'completed',
        output: 'done',
      },
    ]);
  });

  it('keeps the foreground abort attached until adoption and detaches it after adoption', async () => {
    let release: (() => void) | undefined;
    let receivedSignal: AbortSignal | undefined;
    const parent = new AbortController();
    const registry = new BackgroundShellRegistry<string>({ createId: () => 'job-1' });
    const lease = registry.startForeground({
      callId: 'call-1',
      command: 'hold',
      parentSignal: parent.signal,
      run: (signal) =>
        new Promise<string>((resolve) => {
          receivedSignal = signal;
          release = () => resolve('done');
        }),
    });

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    registry.adoptForeground('call-1');
    parent.abort();
    expect(receivedSignal?.aborted).toBe(false);
    expect(registry.cancel('job-1')).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);

    release?.();
    await lease.settled;
    expect(registry.get('job-1')?.status).toBe('cancelled');
  });

  it('leaves a foreground lease owned by its parent when adoption cannot proceed', async () => {
    let release: (() => void) | undefined;
    const parent = new AbortController();
    const registry = new BackgroundShellRegistry<string>({ maxConcurrentJobs: 1 });
    registry.launch({ command: 'existing', run: () => new Promise<string>(() => {}) });
    const lease = registry.startForeground({
      callId: 'call-1',
      command: 'hold',
      parentSignal: parent.signal,
      run: () =>
        new Promise<string>((resolve) => {
          release = () => resolve('stopped');
        }),
    });

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(() => registry.adoptForeground('call-1')).toThrow(BackgroundShellRegistryCapacityError);
    expect(registry.getForeground('call-1')).toMatchObject({ callId: 'call-1', status: 'running' });
    parent.abort();
    release?.();
    await expect(lease.foregroundResult).resolves.toBe('stopped');
  });

  it('does not adopt a lease already claimed by foreground abort', async () => {
    let release: (() => void) | undefined;
    const parent = new AbortController();
    const registry = new BackgroundShellRegistry<string>();
    const lease = registry.startForeground({
      callId: 'call-1',
      command: 'hold',
      parentSignal: parent.signal,
      run: () =>
        new Promise<string>((resolve) => {
          release = () => resolve('cancelled');
        }),
    });

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    parent.abort();
    expect(() => registry.adoptForeground('call-1')).toThrow('already aborting');
    expect(registry.getForeground('call-1')).toMatchObject({ callId: 'call-1' });
    expect(registry.list()).toEqual([]);
    release?.();
    await lease.settled;
  });

  it('rejects adoption after a foreground lease has settled without emitting lifecycle events', async () => {
    const events: unknown[] = [];
    const registry = new BackgroundShellRegistry<string>({ onEvent: (event) => events.push(event) });
    const lease = registry.startForeground({ callId: 'call-1', command: 'fast', run: async () => 'done' });

    await lease.settled;

    expect(() => registry.adoptForeground('call-1')).toThrow('No running foreground');
    expect(events).toEqual([]);
  });

  it('disposal aborts and awaits an unadopted foreground lease', async () => {
    let release: (() => void) | undefined;
    let receivedSignal: AbortSignal | undefined;
    const registry = new BackgroundShellRegistry<string>();
    const lease = registry.startForeground({
      callId: 'call-1',
      command: 'hold',
      run: (signal) =>
        new Promise<string>((resolve) => {
          receivedSignal = signal;
          release = () => resolve('stopped');
        }),
    });

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const disposal = registry.dispose();
    expect(receivedSignal?.aborted).toBe(true);
    release?.();
    await disposal;
    await lease.settled;
  });
});
