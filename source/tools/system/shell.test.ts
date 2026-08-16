import { it, expect, describe, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createBackgroundShellJobToolDefinitions, createShellToolDefinition } from './shell.js';
import { BackgroundShellRegistry } from '../../services/shell/background-shell-registry.js';
import { BackgroundShellOutputStore } from '../../services/shell/background-shell-output-store.js';
import {
  BackgroundShellWatches,
  type BackgroundShellWatchScheduler,
  type ShellOutputFiring,
} from '../../services/shell/background-shell-watches.js';
import { ApprovalLedger, type ToolInvocationContext } from '../../services/agent-runtime/tool-invocation-context.js';
import { SANDBOX_TEMP_DIR } from '../../utils/shell/temp-dir.js';
import {
  deniedReadStore,
  executionOverrideStore,
  resetSandboxDeniedReadStoresForTest,
} from '../../utils/shell/sandbox/denied-read-stores.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import { ExecutionContext } from '../../services/execution-context.js';
import { NestedToolCompatibilityState } from '../../services/session/nested-tool-compatibility-state.js';
import type { ILoggingService, ISSHService } from '../../services/service-interfaces.js';
import {
  clearDockerHostControlSession,
  consumeDockerHostControlDenial,
  grantDockerHostControl,
  recordDockerHostControlDenial,
  requiresDockerHostControlApproval,
  resetDockerHostControlGrantsForTests,
} from '../../utils/shell/sandbox/docker-host-control-grants.js';
import { DOCKER_HOST_CONTROL_RETRY_INSTRUCTION } from '../../utils/shell/sandbox/docker-host-control.js';

beforeEach(() => resetDockerHostControlGrantsForTests());

function createFakeSandboxRunner(overrides: Partial<any> = {}): any {
  return {
    availability: async () => ({ type: 'available' }),
    wrap: async (command: string) => ({ command: `sandboxed(${command})` }),
    cleanupAfterCommand: async () => {},
    annotateFailure: (_command: string, stderr: string) => stderr,
    ...overrides,
  };
}

function createNoopLogger(overrides: Partial<ILoggingService> = {}): ILoggingService {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: () => {},
    getCorrelationId: () => undefined,
    clearCorrelationId: () => {},
    ...overrides,
  };
}

const createNestedCompatibility = () =>
  new NestedToolCompatibilityState(createMockSettingsService({ 'sandbox.dockerHostControlProjects': [] }));

const tempDirs: string[] = [];

function createTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-shell-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  tempDirs.length = 0;
});

function createFakeRtk(): string {
  const dir = createTmpDir();
  const rtkPath = path.join(dir, 'rtk');
  fs.writeFileSync(rtkPath, '#!/bin/sh\nexec "$@"\n');
  fs.chmodSync(rtkPath, 0o755);
  return rtkPath;
}

function createDeferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: resolve! };
}

/** Deterministic timer for the seam tests; no real timers fire. */
class FakeScheduler implements BackgroundShellWatchScheduler {
  #now = 0;
  #nextId = 1;
  readonly #due = new Map<number, { at: number; callback: () => void }>();

  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId++;
    this.#due.set(id, { at: this.#now + delayMs, callback });
    return id;
  }

  cancel(handle: unknown): void {
    this.#due.delete(handle as number);
  }

  advance(ms: number): void {
    this.#now += ms;
    for (;;) {
      const due = [...this.#due.entries()]
        .filter(([, entry]) => entry.at <= this.#now)
        .sort((a, b) => a[1].at - b[1].at);
      if (due.length === 0) return;
      for (const [id, entry] of due) {
        this.#due.delete(id);
        entry.callback();
      }
    }
  }
}

function createMonitorBundle() {
  const store = new BackgroundShellOutputStore();
  const scheduler = new FakeScheduler();
  const firings: ShellOutputFiring[] = [];
  const watches = new BackgroundShellWatches({ store, scheduler, onFiring: (firing) => firings.push(firing) });
  return { store, scheduler, watches, firings };
}

function createSettledRegistry(createId = () => 'monitor-job'): BackgroundShellRegistry<{
  output: string;
  status: 'completed' | 'failed' | 'timed_out';
}> {
  return new BackgroundShellRegistry<{ output: string; status: 'completed' | 'failed' | 'timed_out' }>({ createId });
}

describe('background shell monitor tools', () => {
  it('monitor_shell_job registers a watch on a running job and cancel_shell_monitor removes it', async () => {
    const { store, watches } = createMonitorBundle();
    const registry = createSettledRegistry(() => 'monitored-job');
    const hold = createDeferred<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>();
    registry.launch({
      command: 'npm run dev',
      run: async () => {
        const result = await hold.promise;
        return { output: result.stdout || 'ok', status: result.exitCode === 0 ? 'completed' : 'failed' };
      },
      onSettled: () => undefined,
      resultToStatus: (result) => result.status,
    });
    // The shell-tool seam opens the store stream at launch.
    store.open('monitored-job');
    store.push('monitored-job', 'stdout', 'compiling...\n');
    store.push('monitored-job', 'stdout', 'server listening on 3000\n');

    const jobs = createBackgroundShellJobToolDefinitions(registry, { store, watches });

    const registered = JSON.parse(
      String(await jobs.monitor!.execute({ job_id: 'monitored-job', pattern: 'listening on' })),
    );
    expect(registered).toMatchObject({ jobId: 'monitored-job', status: 'monitoring' });
    expect(registered.watchId).toBeTypeOf('string');

    const cancelled = JSON.parse(String(await jobs.cancelMonitor!.execute({ watch_id: registered.watchId })));
    expect(cancelled).toMatchObject({ watchId: registered.watchId, status: 'cancelled' });

    const missing = JSON.parse(String(await jobs.cancelMonitor!.execute({ watch_id: 'watch-nope' })));
    expect(missing).toMatchObject({ watchId: 'watch-nope', status: 'not_found' });
  });

  it('monitor_shell_job reports not_found for an unknown job and an error for an invalid pattern', async () => {
    const { store, watches } = createMonitorBundle();
    const registry = createSettledRegistry();
    const jobs = createBackgroundShellJobToolDefinitions(registry, { store, watches });

    const unknown = JSON.parse(String(await jobs.monitor!.execute({ job_id: 'no-such-job' })));
    expect(unknown).toMatchObject({ jobId: 'no-such-job', status: 'not_found' });

    const hold = createDeferred<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>();
    registry.launch({
      command: 'npm run dev',
      run: async () => {
        const r = await hold.promise;
        return { output: r.stdout || 'ok', status: 'completed' };
      },
      onSettled: () => undefined,
      resultToStatus: (result) => result.status,
    });
    store.open('monitor-job');
    const invalid = JSON.parse(String(await jobs.monitor!.execute({ job_id: 'monitor-job', pattern: '(' })));
    expect(invalid.status).toBe('error');
    expect(invalid.error).toContain('Invalid monitor pattern');
  });

  it('get_shell_job returns the retained tail for a running job instead of the refusal message', async () => {
    const { store, watches } = createMonitorBundle();
    const registry = createSettledRegistry(() => 'tail-job');
    const hold = createDeferred<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>();
    registry.launch({
      command: 'npm run dev',
      run: async () => {
        const r = await hold.promise;
        return { output: r.stdout || 'ok', status: 'completed' };
      },
      onSettled: () => undefined,
      resultToStatus: (result) => result.status,
    });
    store.open('tail-job');
    store.push('tail-job', 'stdout', 'line one\n');
    store.push('tail-job', 'stdout', 'line two\n');

    const jobs = createBackgroundShellJobToolDefinitions(registry, { store, watches });
    const active = JSON.parse(String(await jobs.get.execute({ job_id: 'tail-job' })));

    expect(active.status).toBe('background_job_active');
    expect(active.tail).toBe('line one\nline two\n');
    expect(active.message).toContain('do not poll');
    expect(active.droppedBytes).toBe(0);
  });

  it('registrations without an output bundle keep the legacy surface and no monitor tools', async () => {
    const registry = new BackgroundShellRegistry<{ output: string; status: 'completed' | 'failed' | 'timed_out' }>({
      createId: () => 'legacy-job',
    });
    const jobs = createBackgroundShellJobToolDefinitions(registry);
    expect(jobs.monitor).toBeUndefined();
    expect(jobs.cancelMonitor).toBeUndefined();
  });

  it('shell-tool seam opens the store at launch, pushes chunks, and settles the watch before completion', async () => {
    const { store, watches, firings } = createMonitorBundle();
    const registry = new BackgroundShellRegistry<{ output: string; status: 'completed' | 'failed' | 'timed_out' }>({
      createId: () => 'seam-job',
    });
    const shell = createShellToolDefinition({
      loggingService: createNoopLogger(),
      settingsService: createMockSettingsService({ 'sandbox.enabled': false }),
      backgroundShellRegistry: registry,
      backgroundShellWatches: watches,
      executeShellCommandImpl: async (_command, options) => {
        // The job prints a line the eventual monitor wants, then completes.
        options?.onOutputChunk?.('stdout', 'server listening on 3000\n');
        return { stdout: 'server listening on 3000\n', stderr: '', exitCode: 0, timedOut: false };
      },
    });

    await shell.execute({ command: 'npm run dev', background: true });

    // The seam opened the store stream and routed the chunk into it.
    const tail = store.readTail('seam-job');
    expect(tail?.text).toContain('server listening on 3000');

    // Registering a monitor after the run still catches the retained output,
    // and settleJob flushes it before the job's completion is terminal.
    const jobs = createBackgroundShellJobToolDefinitions(registry, { store, watches });
    const registered = JSON.parse(
      String(await jobs.monitor!.execute({ job_id: 'seam-job', pattern: 'listening on', once: true })),
    );
    expect(registered.status).toBe('monitoring');

    await registry.whenSettled('seam-job');

    // settleJob closed the store stream and fired the retained match.
    expect(store.readTail('seam-job')?.closed).toBe(true);
    expect(firings).toHaveLength(1);
    expect(firings[0]).toMatchObject({ jobId: 'seam-job', seq: 1, matchedLines: 'server listening on 3000' });
  });
});

describe('background timeout and overflow policy', () => {
  it('background launches use shell.backgroundTimeout and truncate overflow when timeout_ms is absent', async () => {
    const registry = new BackgroundShellRegistry<{ output: string; status: 'completed' | 'failed' | 'timed_out' }>({
      createId: () => 'background-timeout-job',
    });
    const seenOptions: Array<{ timeout?: number; overflow?: 'kill' | 'truncate' }> = [];
    const shell = createShellToolDefinition({
      loggingService: createNoopLogger(),
      settingsService: createMockSettingsService({
        'sandbox.enabled': false,
        'shell.timeout': 120000,
        'shell.backgroundTimeout': 1_800_000,
      }),
      backgroundShellRegistry: registry,
      executeShellCommandImpl: async (_command, options) => {
        seenOptions.push({ timeout: options?.timeout, overflow: options?.overflow });
        return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
      },
    });

    await shell.execute({ command: 'npm run dev', background: true });
    await registry.whenSettled('background-timeout-job');

    expect(seenOptions).toEqual([{ timeout: 1_800_000, overflow: 'truncate' }]);
  });

  it('background launches honor an explicit timeout_ms over shell.backgroundTimeout and still truncate', async () => {
    const registry = new BackgroundShellRegistry<{ output: string; status: 'completed' | 'failed' | 'timed_out' }>({
      createId: () => 'background-timeout-override-job',
    });
    const seenOptions: Array<{ timeout?: number; overflow?: 'kill' | 'truncate' }> = [];
    const shell = createShellToolDefinition({
      loggingService: createNoopLogger(),
      settingsService: createMockSettingsService({
        'sandbox.enabled': false,
        'shell.timeout': 120000,
        'shell.backgroundTimeout': 1_800_000,
      }),
      backgroundShellRegistry: registry,
      executeShellCommandImpl: async (_command, options) => {
        seenOptions.push({ timeout: options?.timeout, overflow: options?.overflow });
        return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
      },
    });

    await shell.execute({ command: 'npm run dev', background: true, timeout_ms: 60_000 });
    await registry.whenSettled('background-timeout-override-job');

    expect(seenOptions).toEqual([{ timeout: 60_000, overflow: 'truncate' }]);
  });

  it('foreground launches keep shell.timeout and the kill overflow default', async () => {
    const seenOptions: Array<{ timeout?: number; overflow?: 'kill' | 'truncate' }> = [];
    const shell = createShellToolDefinition({
      loggingService: createNoopLogger(),
      settingsService: createMockSettingsService({
        'sandbox.enabled': false,
        'shell.timeout': 120000,
        'shell.backgroundTimeout': 1_800_000,
      }),
      executeShellCommandImpl: async (_command, options) => {
        seenOptions.push({ timeout: options?.timeout, overflow: options?.overflow });
        return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
      },
    });

    await shell.execute({ command: 'echo hi' });

    expect(seenOptions).toEqual([{ timeout: 120_000, overflow: 'kill' }]);
  });

  it('foreground launches honor an explicit timeout_ms and keep the kill overflow default', async () => {
    const seenOptions: Array<{ timeout?: number; overflow?: 'kill' | 'truncate' }> = [];
    const shell = createShellToolDefinition({
      loggingService: createNoopLogger(),
      settingsService: createMockSettingsService({
        'sandbox.enabled': false,
        'shell.timeout': 120000,
        'shell.backgroundTimeout': 1_800_000,
      }),
      executeShellCommandImpl: async (_command, options) => {
        seenOptions.push({ timeout: options?.timeout, overflow: options?.overflow });
        return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
      },
    });

    await shell.execute({ command: 'echo hi', timeout_ms: 30_000 });

    expect(seenOptions).toEqual([{ timeout: 30_000, overflow: 'kill' }]);
  });
});

it('background shell acknowledges immediately, exposes status and cancellation, and defers sandbox cleanup', async () => {
  const registry = new BackgroundShellRegistry<{ output: string; status: 'completed' | 'failed' | 'timed_out' }>({
    createId: () => 'background-job',
  });
  const execution = createDeferred<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>();
  let cleanupCalls = 0;
  let receivedSignal: AbortSignal | undefined;
  let correlationId: string | undefined = 'foreground-command';
  const loggingService = createNoopLogger({
    getCorrelationId: () => correlationId,
    setCorrelationId: (next) => {
      correlationId = next;
    },
    clearCorrelationId: () => {
      correlationId = undefined;
    },
  });
  const shell = createShellToolDefinition({
    loggingService,
    settingsService: createMockSettingsService(),
    backgroundShellRegistry: registry,
    shellSandboxRunner: createFakeSandboxRunner({
      cleanupAfterCommand: async () => {
        cleanupCalls += 1;
      },
    }),
    executeShellCommandImpl: async (_command, options) => {
      receivedSignal = options?.signal;
      return execution.promise;
    },
  });
  const jobs = createBackgroundShellJobToolDefinitions(registry);

  expect(jobs.get.description).toContain('Do not use this to poll a running job');

  const acknowledgement = JSON.parse(await shell.execute({ command: 'pnpm test', background: true }));
  expect(acknowledgement).toEqual({ jobId: 'background-job', status: 'running' });
  expect(correlationId).toBe('foreground-command');
  expect(cleanupCalls).toBe(0);
  expect(JSON.parse(String(await jobs.get.execute({ job_id: 'background-job' })))).toEqual({
    status: 'background_job_active',
    jobId: 'background-job',
    message:
      'This background shell job is still running. End the current turn and wait for its automatic completion notification; do not poll get_shell_job.',
  });

  expect(JSON.parse(String(await jobs.cancel.execute({ job_id: 'background-job' })))).toMatchObject({
    jobId: 'background-job',
    status: 'cancelling',
  });
  expect(receivedSignal?.aborted).toBe(true);

  execution.resolve({ stdout: 'stopped', stderr: '', exitCode: 0, timedOut: false });
  await registry.whenSettled('background-job');

  expect(cleanupCalls).toBe(1);
  expect(correlationId).toBe('foreground-command');
  expect(JSON.parse(String(await jobs.get.execute({ job_id: 'background-job' })))).toMatchObject({
    status: 'cancelled',
    output: expect.stringContaining('stopped'),
  });
});

it('background shell reports a timeout as timed_out through the lifecycle event sink', async () => {
  const events: unknown[] = [];
  const registry = new BackgroundShellRegistry<{ output: string; status: 'completed' | 'failed' | 'timed_out' }>({
    createId: () => 'timed-job',
    onEvent: (event) => events.push(event),
  });
  const shell = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': false }),
    backgroundShellRegistry: registry,
    executeShellCommandImpl: async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true }),
  });

  expect(await shell.execute({ command: 'slow-command', background: true })).toBe(
    JSON.stringify({ jobId: 'timed-job', status: 'running' }),
  );
  await registry.whenSettled('timed-job');

  expect(events).toEqual([
    { type: 'background_shell_started', jobId: 'timed-job', command: 'slow-command' },
    expect.objectContaining({
      type: 'background_shell_completed',
      jobId: 'timed-job',
      command: 'slow-command',
      status: 'timed_out',
    }),
  ]);
});

it('background shell clamps output to the configured session maximum even when the caller requests more', async () => {
  const registry = new BackgroundShellRegistry<{ output: string; status: 'completed' | 'failed' | 'timed_out' }>({
    createId: () => 'clamped-job',
  });
  const fullOnlySentinel = 'BACKGROUND-FULL-ONLY-SENTINEL';
  const shell = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': false, 'shell.maxOutputChars': 80 }),
    backgroundShellRegistry: registry,
    executeShellCommandImpl: async () => ({
      stdout: `${'x'.repeat(100)}${fullOnlySentinel}${'y'.repeat(100)}`,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }),
  });

  await shell.execute({ command: 'long-output', background: true, max_output_length: 10_000 });
  const settled = await registry.whenSettled('clamped-job');

  expect(settled?.result?.output).not.toContain(fullOnlySentinel);
  expect(settled?.result?.output).toContain('Full output saved to');
});

it('background denied reads direct a foreground retry without leaving a deferred root approval', async () => {
  const registry = new BackgroundShellRegistry<{ output: string; status: 'completed' | 'failed' | 'timed_out' }>({
    createId: () => 'denied-job',
  });
  const shell = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true, 'sandbox.readPolicy': 'strict' }),
    backgroundShellRegistry: registry,
    postExecuteDeniedRead: true,
    shellSandboxRunner: createFakeSandboxRunner({
      annotateFailure: (_command: string, stderr: string) =>
        `${stderr}\n<sandbox_violations>\nSandbox: cat(123) deny file-read* /home/testuser/.cargo/registry/cache\n</sandbox_violations>`,
    }),
    executeShellCommandImpl: async () => ({
      stdout: '',
      stderr: 'cat: error',
      exitCode: 1,
      timedOut: false,
    }),
  });
  const details = { toolCall: { callId: 'background-denied-read' } };

  const acknowledgement = await shell.execute(
    { command: 'cat ~/.cargo/registry/cache', background: true },
    undefined,
    details,
  );
  const settled = await registry.whenSettled('denied-job');

  expect(settled?.result?.output).toContain('foreground');
  expect(
    shell.postExecutePause!.describe(
      { command: 'cat ~/.cargo/registry/cache', background: true },
      acknowledgement,
      details,
    ),
  ).toBeNull();
});

it('background shell logs retain their own correlation while a foreground trace is active', async () => {
  const execution = createDeferred<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>();
  const debugCalls: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  let currentCorrelationId: string | undefined = 'foreground-trace';
  const registry = new BackgroundShellRegistry<{ output: string; status: 'completed' | 'failed' | 'timed_out' }>({
    createId: () => 'correlated-job',
  });
  const shell = createShellToolDefinition({
    loggingService: createNoopLogger({
      debug: (message, meta) => debugCalls.push({ message, meta }),
      getCorrelationId: () => currentCorrelationId,
      setCorrelationId: (id) => {
        currentCorrelationId = id;
      },
      clearCorrelationId: () => {
        currentCorrelationId = undefined;
      },
    }),
    settingsService: createMockSettingsService({ 'sandbox.enabled': false }),
    backgroundShellRegistry: registry,
    executeShellCommandImpl: async () => execution.promise,
  });

  await shell.execute({ command: 'deferred-output', background: true });
  execution.resolve({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false });
  await registry.whenSettled('correlated-job');

  const backgroundCorrelationIds = debugCalls
    .filter(({ message }) => message.startsWith('Shell command'))
    .map(({ meta }) => meta?.correlationId);
  expect(backgroundCorrelationIds).toHaveLength(3);
  expect(new Set(backgroundCorrelationIds).size).toBe(1);
  expect(backgroundCorrelationIds[0]).not.toBe('foreground-trace');
  expect(currentCorrelationId).toBe('foreground-trace');
});

it('moves a running root shell call into the registry without a second execution or early cleanup', async () => {
  const registry = new BackgroundShellRegistry<{ output: string; status: 'completed' | 'failed' | 'timed_out' }>({
    createId: () => 'moved-job',
  });
  const execution = createDeferred<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>();
  const parent = new AbortController();
  let cleanupCalls = 0;
  let receivedSignal: AbortSignal | undefined;
  const shell = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
    backgroundShellRegistry: registry,
    shellSandboxRunner: createFakeSandboxRunner({
      cleanupAfterCommand: async () => {
        cleanupCalls += 1;
      },
    }),
    executeShellCommandImpl: async (_command, options) => {
      receivedSignal = options?.signal;
      return execution.promise;
    },
  });
  const context: ToolInvocationContext = { context: undefined, approvals: new ApprovalLedger(), signal: parent.signal };
  const foregroundResult = shell.execute({ command: 'long-command' }, context, { toolCall: { callId: 'call-move' } });

  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(registry.getForeground('call-move')).toMatchObject({ jobId: 'moved-job', command: 'long-command' });
  expect(registry.adoptForeground('call-move')).toEqual({ jobId: 'moved-job', status: 'running' });
  await expect(foregroundResult).resolves.toBe(JSON.stringify({ jobId: 'moved-job', status: 'running' }));
  expect(cleanupCalls).toBe(0);

  parent.abort();
  expect(receivedSignal?.aborted).toBe(false);
  expect(registry.cancel('moved-job')).toBe(true);
  expect(receivedSignal?.aborted).toBe(true);
  execution.resolve({ stdout: 'stopped', stderr: '', exitCode: 0, timedOut: false });
  await registry.whenSettled('moved-job');

  expect(cleanupCalls).toBe(1);
  expect(registry.get('moved-job')).toMatchObject({ status: 'cancelled' });
});

it('applies the configured background output cap after a foreground shell is transferred', async () => {
  const registry = new BackgroundShellRegistry<{ output: string; status: 'completed' | 'failed' | 'timed_out' }>({
    createId: () => 'capped-move-job',
  });
  const execution = createDeferred<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>();
  const shell = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.maxOutputChars': 40 }),
    backgroundShellRegistry: registry,
    shellSandboxRunner: createFakeSandboxRunner(),
    executeShellCommandImpl: async () => execution.promise,
  });
  const foreground = shell.execute(
    { command: 'long-output', max_output_length: 1_000 },
    { context: undefined, approvals: new ApprovalLedger() },
    { toolCall: { callId: 'call-capped-move' } },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  registry.adoptForeground('call-capped-move');
  await foreground;
  execution.resolve({ stdout: `start-${'x'.repeat(160)}-uncapped-tail`, stderr: '', exitCode: 0, timedOut: false });
  const settled = await registry.whenSettled('capped-move-job');

  expect(settled?.result?.output).not.toContain('x'.repeat(50));
  expect(settled?.result?.output).toContain('characters trimmed');
});

it('reports a denied read after foreground transfer as a background-only failure', async () => {
  const registry = new BackgroundShellRegistry<{ output: string; status: 'completed' | 'failed' | 'timed_out' }>({
    createId: () => 'denied-move-job',
  });
  const execution = createDeferred<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>();
  const shell = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true, 'sandbox.readPolicy': 'strict' }),
    backgroundShellRegistry: registry,
    postExecuteDeniedRead: true,
    shellSandboxRunner: createFakeSandboxRunner({
      annotateFailure: (_command: string, stderr: string) =>
        `${stderr}\n<sandbox_violations>\nSandbox: cat(123) deny file-read* /home/testuser/.cache\n</sandbox_violations>`,
    }),
    executeShellCommandImpl: async () => execution.promise,
  });
  const details = { toolCall: { callId: 'call-denied-move' } };
  const foreground = shell.execute(
    { command: 'cat ~/.cache' },
    { context: undefined, approvals: new ApprovalLedger() },
    details,
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  registry.adoptForeground('call-denied-move');
  const acknowledgement = await foreground;
  execution.resolve({ stdout: '', stderr: 'cat: denied', exitCode: 1, timedOut: false });
  const settled = await registry.whenSettled('denied-move-job');

  expect(settled?.result?.output).toContain('Background jobs cannot request permission');
  expect(shell.postExecutePause!.describe({ command: 'cat ~/.cache' }, acknowledgement, details)).toBeNull();
});

it.sequential('shell execute appends spill-file guidance when output is truncated', async () => {
  const longStdout = `${'x'.repeat(6000)}FULL-ONLY-SENTINEL${'y'.repeat(6000)}`;

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': false }),
    executeShellCommandImpl: async () => ({
      stdout: longStdout,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }),
  });

  const output = await tool.execute({
    command: 'demo --long-output',
    timeout_ms: 60000,
    max_output_length: 120,
  });

  expect(output.includes('Full output saved to')).toBe(true);
  expect(/Runtime: \d+ms/.test(output)).toBe(true);
  expect(output.includes('FULL-ONLY-SENTINEL')).toBe(false);
});

it('shell description mentions saved long output and avoiding reruns', () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
    shellSandboxRunner: createFakeSandboxRunner(),
  });

  expect(tool.description.includes('full output is saved to a file')).toBe(true);
});

it('retains the schema sandbox default while accepting raw invocations that omit it', async () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
  });

  expect(tool.parameters.parse({ command: 'pwd' }).sandbox).toBe('default');
  expect(tool.parameters.parse({ command: 'pwd' }).background).toBe(false);
  await expect(tool.needsApproval({ command: 'pwd' })).resolves.toBeTypeOf('boolean');
});

it('orchestrator shell description permits proportionate direct command use', () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
    orchestratorMode: true,
  });

  expect(tool.description).toContain('Directly inspect, test, or perform a small clear operation');
  expect(tool.description).not.toContain('to verify state');
});

it('shell description is adjusted based on searchViaShell explicit option and settings', () => {
  const toolExplicitFalse = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
    searchViaShell: false,
  });
  expect(toolExplicitFalse.description.includes('Do NOT use this to read, write or search.')).toBe(true);

  const toolExplicitTrue = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
    searchViaShell: true,
  });
  expect(
    toolExplicitTrue.description.includes('Do NOT use this to write. Use the specialized tools for those tasks.'),
  ).toBe(true);
  expect(toolExplicitTrue.description.includes('Do NOT use this to read, write or search.')).toBe(false);

  const toolSettingsOn = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({
      'app.searchViaShell': 'on',
    }),
  });
  expect(
    toolSettingsOn.description.includes('Do NOT use this to write. Use the specialized tools for those tasks.'),
  ).toBe(true);

  const toolSettingsOff = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({
      'app.searchViaShell': 'off',
    }),
  });
  expect(toolSettingsOff.description.includes('Do NOT use this to read, write or search.')).toBe(true);

  const toolSettingsAutoGpt5 = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({
      'app.searchViaShell': 'auto',
      'agent.model': 'gpt-5-turbo',
    }),
  });
  expect(
    toolSettingsAutoGpt5.description.includes('Do NOT use this to write. Use the specialized tools for those tasks.'),
  ).toBe(true);

  const toolSettingsAutoNonGpt5 = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({
      'app.searchViaShell': 'auto',
      'agent.model': 'gpt-4o',
    }),
  });
  expect(toolSettingsAutoNonGpt5.description.includes('Do NOT use this to read, write or search.')).toBe(true);
});

it('shell schema accepts omitted, default, and unsandboxed sandbox modes', () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
  });

  expect(tool.parameters.parse({ command: 'pwd' }).sandbox).toBe('default');
  expect(tool.parameters.parse({ command: 'pwd', sandbox: 'default' }).sandbox).toBe('default');
  expect(tool.parameters.parse({ command: 'pwd', sandbox: 'unsandboxed' }).sandbox).toBe('unsandboxed');
  expect(tool.parameters.parse({ command: 'pwd', background: true }).background).toBe(true);
  expect(() => tool.parameters.parse({ command: 'pwd', sandbox: 'off' })).toThrow();
});

it('shell schema does not expose Docker host control', () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
  });

  expect(tool.parameters.shape).not.toHaveProperty('docker_host_control');
});

it('shell schema does not expose Docker host control when the sandbox is disabled', () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': false }),
  });

  expect(tool.parameters.shape).not.toHaveProperty('docker_host_control');
});

it('shell needsApproval always prompts for unsandboxed execution', async () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
  });

  expect(await tool.needsApproval({ command: 'ls', sandbox: 'unsandboxed' })).toBe(true);
});

it('shell needsApproval bypasses even unsandboxed execution in YOLO mode', async () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.autoApproveMode': 'always', 'sandbox.enabled': false }),
  });

  expect(await tool.needsApproval({ command: 'ls', sandbox: 'unsandboxed' })).toBe(false);
});

it('shell needsApproval prompts for Docker commands in the sandbox', async () => {
  const nestedCompatibility = createNestedCompatibility();
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
    nestedCompatibility,
  });

  expect(await tool.needsApproval({ command: 'docker ps' })).toBe(true);
});

it('Docker session grants do not suppress approval in another session sharing the same cwd', async () => {
  const cwd = process.cwd();
  const nestedCompatibility = createNestedCompatibility();
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
    shellSandboxRunner: createFakeSandboxRunner(),
    nestedCompatibility,
  });
  const sessionA = { context: { sessionId: 'session-a' } };
  const sessionB = { context: { sessionId: 'session-b' } };

  nestedCompatibility.docker.grant({
    command: 'docker ps',
    cwd: path.join(cwd, '.'),
    scope: 'session',
    sessionId: 'session-a',
  });
  expect(await tool.needsApproval({ command: 'docker ps' }, sessionA)).toBe(false);
  expect(await tool.needsApproval({ command: 'docker ps' }, sessionB)).toBe(true);

  const projectCompatibility = createNestedCompatibility();
  const projectTool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
    shellSandboxRunner: createFakeSandboxRunner(),
    nestedCompatibility: projectCompatibility,
  });
  projectCompatibility.docker.grant({
    command: 'docker ps',
    cwd,
    scope: 'project',
    sessionId: 'session-a',
  });
  expect(await projectTool.needsApproval({ command: 'docker ps' }, sessionB)).toBe(false);
});

it('does not apply Docker authorization when the sandbox is disabled', async () => {
  let dockerFactoryCalled = false;
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': false }),
    dockerHostControlFactory: () => {
      dockerFactoryCalled = true;
      throw new Error('must not create Docker access');
    },
    executeShellCommandImpl: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
  });
  grantDockerHostControl({ command: 'docker ps', cwd: process.cwd(), scope: 'session', sessionId: 'session-a' });

  await tool.execute({ command: 'docker ps' });
  expect(dockerFactoryCalled).toBe(false);
});

it('shell needsApproval follows sandbox.enabled changes made after the tool was created', async () => {
  const settingsService = createMockSettingsService({ 'sandbox.enabled': false });
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService,
    shellSandboxRunner: createFakeSandboxRunner({
      availability: async () => ({ type: 'missing_dependency', reason: 'sandbox runtime unavailable' }),
    }),
  });

  settingsService.set('sandbox.enabled', true);

  // Sandbox is on but unavailable, so an otherwise harmless command must prompt.
  expect(await tool.needsApproval({ command: 'pwd' })).toBe(true);
});

it('turns a sandboxed Docker daemon block into an approvable retry for an indirect command', async () => {
  const dockerStderr =
    'WARNING: Error loading config file: open /Users/me/.docker/config.json: operation not permitted\n' +
    'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock';
  let dockerFactoryCalled = false;
  const executed: string[] = [];
  const nestedCompatibility = createNestedCompatibility();
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner(),
    dockerHostControlFactory: () => {
      dockerFactoryCalled = true;
      return { socketPath: '/tmp/docker.sock', configDir: createTmpDir(), cleanup: () => {} };
    },
    executeShellCommandImpl: async (command: string) => {
      executed.push(command);
      return { stdout: '', stderr: dockerFactoryCalled ? '' : dockerStderr, exitCode: 1, timedOut: false };
    },
    nestedCompatibility,
  });
  const sessionA = { context: { sessionId: 'session-a' } };

  // 1. The command never mentions Docker, so it runs sandboxed and is blocked.
  expect(await tool.needsApproval({ command: 'pnpm test' }, sessionA)).toBe(false);
  const blocked = await tool.execute({ command: 'pnpm test' }, sessionA);
  expect(blocked).toContain(DOCKER_HOST_CONTROL_RETRY_INSTRUCTION);
  expect(dockerFactoryCalled).toBe(false);

  // 2. The retry is now approvable, and refused until a grant exists.
  expect(await tool.needsApproval({ command: 'pnpm test' }, sessionA)).toBe(true);
  expect(await tool.execute({ command: 'pnpm test' }, sessionA)).toContain('requires explicit approval');

  // 3. Once granted, the same command runs with Docker host control.
  nestedCompatibility.docker.grant({
    command: 'pnpm test',
    cwd: process.cwd(),
    scope: 'once',
    sessionId: 'session-a',
  });
  const granted = await tool.execute({ command: 'pnpm test' }, sessionA);
  expect(dockerFactoryCalled).toBe(true);
  expect(granted).not.toContain('requires explicit approval');
  expect(executed).toHaveLength(2);
});

it('grants Docker host control on the retry the approval flow actually produces', async () => {
  let dockerFactoryCalled = false;
  const nestedCompatibility = createNestedCompatibility();
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner(),
    dockerHostControlFactory: () => {
      dockerFactoryCalled = true;
      return { socketPath: '/tmp/docker.sock', configDir: createTmpDir(), cleanup: () => {} };
    },
    executeShellCommandImpl: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    nestedCompatibility,
  });
  const sessionA = { context: { sessionId: 'session-a' } };

  // Exactly what prepareContinuation does when the user approves a blocked command.
  nestedCompatibility.docker.recordDenial('session-a', 'pnpm test');
  nestedCompatibility.docker.grant({
    command: 'pnpm test',
    cwd: process.cwd(),
    scope: 'once',
    sessionId: 'session-a',
  });

  expect(await tool.execute({ command: 'pnpm test' }, sessionA)).not.toContain('requires explicit approval');
  expect(dockerFactoryCalled).toBe(true);
  // The request is settled by the run that used it, not before.
  expect(nestedCompatibility.docker.requiresApproval('session-a', 'pnpm test')).toBe(false);
});

it('does not force a second session through approval because another session was blocked from Docker', async () => {
  const nestedCompatibility = createNestedCompatibility();
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner(),
    executeShellCommandImpl: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    nestedCompatibility,
  });
  const sessionA = { context: { sessionId: 'session-a' } };
  const sessionB = { context: { sessionId: 'session-b' } };

  nestedCompatibility.docker.recordDenial('session-a', 'pnpm test');

  // Session A earned the prompt; session B never hit the block and must not
  // inherit it, nor be refused for lacking a grant it was never asked for.
  expect(await tool.needsApproval({ command: 'pnpm test' }, sessionA)).toBe(true);
  expect(await tool.needsApproval({ command: 'pnpm test' }, sessionB)).toBe(false);
  expect(await tool.execute({ command: 'pnpm test' }, sessionB)).not.toContain('requires explicit approval');
});

it('forgets a session’s Docker block when that session ends', async () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner(),
    executeShellCommandImpl: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
  });
  const sessionA = { context: { sessionId: 'session-a' } };
  recordDockerHostControlDenial('session-a', 'pnpm test');

  clearDockerHostControlSession('session-a');

  expect(await tool.needsApproval({ command: 'pnpm test' }, sessionA)).toBe(false);
});

it('a denied Docker request lets the command run sandboxed again instead of looping on approval', async () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner(),
    executeShellCommandImpl: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
  });
  const sessionA = { context: { sessionId: 'session-a' } };
  recordDockerHostControlDenial('session-a', 'pnpm test');

  // The approval flow clears the pending request when the user decides.
  consumeDockerHostControlDenial('session-a', 'pnpm test');

  expect(await tool.needsApproval({ command: 'pnpm test' }, sessionA)).toBe(false);
  expect(await tool.execute({ command: 'pnpm test' }, sessionA)).not.toContain('requires explicit approval');
});

it('consumes a one-shot Docker grant only for its exact command', async () => {
  const nestedCompatibility = createNestedCompatibility();
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner(),
    dockerHostControlFactory: () => ({ socketPath: '/tmp/docker.sock', configDir: createTmpDir(), cleanup: () => {} }),
    executeShellCommandImpl: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    nestedCompatibility,
  });
  nestedCompatibility.docker.grant({
    command: 'docker ps',
    cwd: process.cwd(),
    scope: 'once',
    sessionId: 'session-a',
  });
  const sessionA = { context: { sessionId: 'session-a' } };

  expect(await tool.execute({ command: 'docker images' }, sessionA)).toContain('requires explicit approval');
  expect(await tool.execute({ command: 'docker ps' }, sessionA)).not.toContain('requires explicit approval');
  expect(await tool.execute({ command: 'docker ps' }, sessionA)).toContain('requires explicit approval');
});

it('shell execute refuses Docker host control when the local sandbox is unavailable', async () => {
  let executed = false;
  const nestedCompatibility = createNestedCompatibility();
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner({
      availability: async () => ({ type: 'missing_dependency', reason: 'sandbox runtime unavailable' }),
    }),
    dockerHostControlFactory: () => ({
      socketPath: '/private/var/run/docker.sock',
      configDir: createTmpDir(),
      cleanup: () => {},
    }),
    executeShellCommandImpl: async () => {
      executed = true;
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    },
    nestedCompatibility,
  });

  nestedCompatibility.docker.grant({
    command: 'docker ps',
    cwd: process.cwd(),
    scope: 'once',
    sessionId: 'session-a',
  });
  const output = await tool.execute({ command: 'docker ps' }, { context: { sessionId: 'session-a' } });

  expect(executed).toBe(false);
  expect(output).toContain('requires an available local sandbox');
});

it('shell execute retains the Docker socket error after an approved grant', async () => {
  const nestedCompatibility = createNestedCompatibility();
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner(),
    dockerHostControlFactory: () => {
      throw new Error('Docker socket is unavailable');
    },
    nestedCompatibility,
  });
  nestedCompatibility.docker.grant({
    command: 'docker ps',
    cwd: process.cwd(),
    scope: 'once',
    sessionId: 'session-a',
  });

  const output = await tool.execute({ command: 'docker ps' }, { context: { sessionId: 'session-a' } });

  expect(output).toContain('Docker socket is unavailable');
});

it.sequential('shell execute restores previous correlation id after command execution', async () => {
  let clearCorrelationCalls = 0;
  let currentCorrelationId: string | undefined = 'trace-parent';

  const loggingService: ILoggingService = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: (id: string | undefined) => {
      currentCorrelationId = id;
    },
    getCorrelationId: () => currentCorrelationId,
    clearCorrelationId: () => {
      currentCorrelationId = undefined;
      clearCorrelationCalls += 1;
    },
  };

  const tool = createShellToolDefinition({
    loggingService,
    settingsService: createMockSettingsService({ 'sandbox.enabled': false }),
  });

  const output = await tool.execute({
    command: 'printf hello',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(output.includes('exit 0')).toBe(true);
  expect(currentCorrelationId).toBe('trace-parent');
  expect(clearCorrelationCalls).toBe(0);
});

it.sequential('shell execute clears correlation id when no previous correlation exists', async () => {
  let currentCorrelationId: string | undefined = undefined;
  let clearCorrelationCalls = 0;

  const loggingService: ILoggingService = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: (id: string | undefined) => {
      currentCorrelationId = id;
    },
    getCorrelationId: () => currentCorrelationId,
    clearCorrelationId: () => {
      currentCorrelationId = undefined;
      clearCorrelationCalls += 1;
    },
  };

  const tool = createShellToolDefinition({
    loggingService,
    settingsService: createMockSettingsService({ 'sandbox.enabled': false }),
  });

  await tool.execute({
    command: 'printf hello',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(currentCorrelationId).toBe(undefined);
  expect(clearCorrelationCalls).toBe(1);
});

it.sequential('shell execute stops a running command when the tool invocation is aborted', async () => {
  const abortController = new AbortController();
  const registry = new BackgroundShellRegistry<{ output: string; status: 'completed' | 'failed' | 'timed_out' }>();
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': false }),
    backgroundShellRegistry: registry,
  });

  const outputPromise = tool.execute(
    {
      command: 'sleep 1; printf finished',
      timeout_ms: 60000,
      max_output_length: 10000,
    },
    { context: undefined, approvals: new ApprovalLedger(), signal: abortController.signal },
    { toolCall: { callId: 'call-foreground-abort' } },
  );

  queueMicrotask(() => abortController.abort());
  const output = await outputPromise;

  expect(output.startsWith('timeout')).toBe(true);
  expect(output.includes('finished')).toBe(false);
});

it.sequential('shell execute characterizes the post-approval RTK command boundary', async () => {
  const rtkPath = '/tmp/rtk/rtk';
  const executedCommands: string[] = [];
  let installerCalls = 0;
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true, 'sandbox.enabled': false }),
    rtkInstaller: async () => {
      installerCalls += 1;
      return rtkPath;
    },
    executeShellCommandImpl: async (command) => {
      executedCommands.push(command);
      return { stdout: 'stubbed', stderr: '', exitCode: 0, timedOut: false };
    },
  });

  const corpus = [
    {
      command: 'ls package.json',
      expected: '"/tmp/rtk/rtk" ls package.json',
    },
    {
      command: 'printf hello',
      expected: 'printf hello',
    },
    {
      command: 'curl https://example.com',
      expected: 'curl https://example.com',
    },
    {
      command: 'git log | grep x',
      expected: 'git log | grep x',
    },
    {
      command: 'git status > out.txt',
      expected: 'git status > out.txt',
    },
    {
      command: 'curl https://example.com && git log',
      expected: 'curl https://example.com && "/tmp/rtk/rtk" git log',
    },
  ];

  for (const { command, expected } of corpus) {
    await tool.execute({ command, timeout_ms: 60_000, max_output_length: 10_000 });
    expect(executedCommands.at(-1)).toBe(expected);
  }

  // The installer has no command argument: the exact corpus above is the
  // supported-command admission evidence, while the executor spy proves the
  // corresponding rewrite strings independently of the AST helper.
  expect(installerCalls).toBe(2);
});

it.sequential(
  'shell execute leaves an eligible local command unchanged when RTK installation resolves null',
  async () => {
    let executedCommand: string | undefined;
    let installerCalls = 0;
    const tool = createShellToolDefinition({
      loggingService: createNoopLogger(),
      settingsService: createMockSettingsService({ 'shell.useRtkCompression': true, 'sandbox.enabled': false }),
      rtkInstaller: async () => {
        installerCalls += 1;
        return null;
      },
      executeShellCommandImpl: async (command) => {
        executedCommand = command;
        return { stdout: 'stubbed', stderr: '', exitCode: 0, timedOut: false };
      },
    });

    await tool.execute({ command: 'ls package.json', timeout_ms: 60_000, max_output_length: 10_000 });

    expect(installerCalls).toBe(1);
    expect(executedCommand).toBe('ls package.json');
  },
);

it.sequential('shell execute bypasses RTK for SSH through the remote execution seam', async () => {
  let installerCalls = 0;
  let remoteCommand: string | undefined;
  const sshService: ISSHService = {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    executeCommand: async (command) => {
      remoteCommand = command;
      return { stdout: 'stubbed remote', stderr: '', exitCode: 0, timedOut: false };
    },
    readFile: async () => '',
    writeFile: async () => {},
    mkdir: async () => {},
  };
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true }),
    executionContext: new ExecutionContext(sshService, '/remote/workspace'),
    rtkInstaller: async () => {
      installerCalls += 1;
      return '/tmp/rtk/rtk';
    },
    executeShellCommandImpl: async (command, options) => {
      expect(options?.sshService).toBe(sshService);
      return sshService.executeCommand(command);
    },
  });

  await tool.execute({ command: 'ls package.json', timeout_ms: 60_000, max_output_length: 10_000 });

  expect(installerCalls).toBe(0);
  expect(remoteCommand).toBe('ls package.json');
});

it.sequential('shell execute propagates an injected RTK installer rejection', async () => {
  let executorCalled = false;
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true, 'sandbox.enabled': false }),
    rtkInstaller: async () => {
      throw new Error('installer seam failed');
    },
    executeShellCommandImpl: async () => {
      executorCalled = true;
      return { stdout: 'stubbed', stderr: '', exitCode: 0, timedOut: false };
    },
  });

  await expect(tool.execute({ command: 'ls package.json' })).rejects.toThrow('installer seam failed');
  expect(executorCalled).toBe(false);
});

it.sequential('shell execute does not install RTK for unsupported commands', async () => {
  let installCalled = false;

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true, 'sandbox.enabled': false }),
    rtkInstaller: async () => {
      installCalled = true;
      return '/tmp/rtk';
    },
  });

  const output = await tool.execute({
    command: 'printf hello',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(output.includes('exit 0')).toBe(true);
  expect(installCalled).toBe(false);
});

it.sequential('shell execute wraps eligible RTK commands', async () => {
  let installCalled = false;
  let wrappedCommand: string | undefined;
  const rtkPath = createFakeRtk();

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger({
      debug: (message: string, meta?: any) => {
        if (message === 'Wrapped command with rtk') {
          wrappedCommand = meta?.original;
        }
      },
    }),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true, 'sandbox.enabled': false }),
    rtkInstaller: async () => {
      installCalled = true;
      return rtkPath;
    },
  });

  const output = await tool.execute({
    command: 'ls package.json',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(output.includes('package.json')).toBe(true);
  expect(installCalled).toBe(true);
  expect(wrappedCommand).toBe('ls package.json');
});

it.sequential('shell execute does not install RTK for allowlisted commands in a pipeline', async () => {
  let installCalled = false;

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true, 'sandbox.enabled': false }),
    rtkInstaller: async () => {
      installCalled = true;
      return createFakeRtk();
    },
  });

  const output = await tool.execute({
    command: 'cat package.json | head -n 1',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(output.includes('exit 0')).toBe(true);
  expect(installCalled).toBe(false);
});

it.sequential('shell execute does not install RTK for allowlisted commands redirected to files', async () => {
  let installCalled = false;
  const dir = createTmpDir();
  const stdoutPath = path.join(dir, 'stdout.txt');
  const stderrPath = path.join(dir, 'stderr.txt');

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true, 'sandbox.enabled': false }),
    rtkInstaller: async () => {
      installCalled = true;
      return createFakeRtk();
    },
  });

  const stdoutRedirect = await tool.execute({
    command: `cat package.json > ${stdoutPath}`,
    timeout_ms: 60000,
    max_output_length: 10000,
  });
  const stderrRedirect = await tool.execute({
    command: `ls ${path.join(dir, 'missing')} 2> ${stderrPath}`,
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(stdoutRedirect.includes('exit 0')).toBe(true);
  expect(stderrRedirect.includes('exit 1') || stderrRedirect.includes('exit 2')).toBe(true); // Different variants of ls can return either exit 1 or exit 2
  expect(fs.existsSync(stdoutPath)).toBe(true);
  expect(fs.existsSync(stderrPath)).toBe(true);
  expect(installCalled).toBe(false);
});

it.sequential('shell execute bypasses RTK for SSH commands', async () => {
  let installCalled = false;
  let executedCommand: string | undefined;
  const sshService: ISSHService = {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    executeCommand: async (cmd: string) => {
      executedCommand = cmd;
      return { stdout: 'remote\n', stderr: '', exitCode: 0, timedOut: false };
    },
    readFile: async () => '',
    writeFile: async () => {},
    mkdir: async () => {},
  };

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true }),
    executionContext: new ExecutionContext(sshService, '/remote/workspace'),
    rtkInstaller: async () => {
      installCalled = true;
      return createFakeRtk();
    },
  });

  const output = await tool.execute({
    command: 'ls package.json',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(output.includes('remote')).toBe(true);
  expect(executedCommand).toBe('ls package.json');
  expect(installCalled).toBe(false);
});

it.sequential('shell execute wraps local default commands with the sandbox when enabled and available', async () => {
  let executedCommand: string | undefined;
  let receivedEnv: NodeJS.ProcessEnv | undefined;
  let receivedPauseOnNetworkApproval: boolean | undefined;
  let wrappedCommand: string | undefined;
  let receivedReadPolicy: string | undefined;
  let receivedAllowReadExtra: string[] | undefined;
  let cleanupCalls = 0;
  const runner = createFakeSandboxRunner({
    wrap: async (command: string, options: any) => {
      wrappedCommand = command;
      receivedReadPolicy = options.config?.filesystem?.allowRead ? 'strict' : 'standard';
      receivedAllowReadExtra = options.config?.filesystem?.allowRead;
      return { command: `sandboxed(${command})`, diagnostics: ['sandbox active'] };
    },
    cleanupAfterCommand: async () => {
      cleanupCalls += 1;
    },
  });

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({
      'sandbox.enabled': true,
      'sandbox.readPolicy': 'strict',
      'sandbox.allowReadExtra': ['/tmp/tool-cache'],
    }),
    shellSandboxRunner: runner,
    executeShellCommandImpl: async (command, options) => {
      executedCommand = command;
      receivedEnv = options?.env;
      receivedPauseOnNetworkApproval = options?.pauseOnSandboxNetworkApproval;
      return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
    },
  });

  const output = await tool.execute({ command: 'pwd', sandbox: 'default' });

  expect(wrappedCommand).toBe('pwd');
  expect(receivedReadPolicy).toBe('strict');
  expect(receivedAllowReadExtra).toContain('/tmp/tool-cache');
  expect(executedCommand).toBe('sandboxed(pwd)');
  expect(receivedPauseOnNetworkApproval).toBe(true);
  expect(receivedEnv).toBeTruthy();
  expect(receivedEnv?.HOME).toBe(os.homedir());
  expect(receivedEnv?.XDG_CONFIG_HOME).toContain(SANDBOX_TEMP_DIR);
  expect(receivedEnv?.XDG_CACHE_HOME).toContain(SANDBOX_TEMP_DIR);
  expect(receivedEnv?.XDG_DATA_HOME).toContain(SANDBOX_TEMP_DIR);
  expect(receivedEnv?.XDG_STATE_HOME).toContain(SANDBOX_TEMP_DIR);
  expect(cleanupCalls).toBe(1);
  expect(output.includes('ok')).toBe(true);
});

it.sequential('shell execute grants Docker host control only to the approved sandboxed command', async () => {
  let receivedSocketPaths: string[] | undefined;
  let receivedEnv: NodeJS.ProcessEnv | undefined;
  let cleanupCalls = 0;
  const configDir = createTmpDir();
  const socketPath = '/private/var/run/docker.sock';
  const nestedCompatibility = createNestedCompatibility();
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner({
      wrap: async (command: string, options: any) => {
        receivedSocketPaths = options.config.network.allowUnixSockets;
        return { command: `sandboxed(${command})` };
      },
    }),
    dockerHostControlFactory: () => ({
      socketPath,
      configDir,
      cleanup: () => {
        cleanupCalls += 1;
      },
    }),
    executeShellCommandImpl: async (_command, options) => {
      receivedEnv = options?.env;
      return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
    },
    nestedCompatibility,
  });

  nestedCompatibility.docker.grant({
    command: 'docker ps',
    cwd: process.cwd(),
    scope: 'once',
    sessionId: 'session-a',
  });
  // The sandbox policy intentionally allows the caller's tmux socket (from the
  // TMUX env var) alongside the docker socket (see sandbox-policy.ts). Keep this
  // test hermetic regardless of the host terminal so the assertion sees exactly
  // the approved docker socket.
  const originalTmux = process.env.TMUX;
  delete process.env.TMUX;
  let output: Awaited<ReturnType<typeof tool.execute>>;
  try {
    output = await tool.execute({ command: 'docker ps' }, { context: { sessionId: 'session-a' } });
  } finally {
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
  }

  expect(receivedSocketPaths).toEqual([socketPath]);
  expect(receivedEnv?.DOCKER_HOST).toBe(`unix://${socketPath}`);
  expect(receivedEnv?.DOCKER_CONFIG).toBe(configDir);
  expect(cleanupCalls).toBe(1);
  expect(output).toContain('ok');
});

it.sequential('shell execute leaves XDG unset in standard sandbox mode', async () => {
  let receivedEnv: NodeJS.ProcessEnv | undefined;

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({
      'sandbox.enabled': true,
    }),
    shellSandboxRunner: createFakeSandboxRunner(),
    executeShellCommandImpl: async (_command, options) => {
      receivedEnv = options?.env;
      return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
    },
  });

  await tool.execute({ command: 'pwd', sandbox: 'default' });

  expect(receivedEnv?.HOME).toBe(os.homedir());
  expect(receivedEnv?.XDG_CONFIG_HOME).toBeUndefined();
  expect(receivedEnv?.XDG_CACHE_HOME).toBeUndefined();
  expect(receivedEnv?.XDG_DATA_HOME).toBeUndefined();
  expect(receivedEnv?.XDG_STATE_HOME).toBeUndefined();
});

it.sequential('shell execute bypasses sandbox for SSH commands', async () => {
  let sandboxWrapped = false;
  let executedCommand: string | undefined;
  const sshService: ISSHService = {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    executeCommand: async (cmd: string) => {
      executedCommand = cmd;
      return { stdout: 'remote', stderr: '', exitCode: 0, timedOut: false };
    },
    readFile: async () => '',
    writeFile: async () => {},
    mkdir: async () => {},
  };

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    executionContext: new ExecutionContext(sshService, '/remote/workspace'),
    shellSandboxRunner: createFakeSandboxRunner({
      wrap: async () => {
        sandboxWrapped = true;
        return { command: 'sandboxed' };
      },
    }),
  });

  const output = await tool.execute({ command: 'pwd', sandbox: 'default' });

  expect(sandboxWrapped).toBe(false);
  expect(executedCommand).toBe('pwd');
  expect(output.includes('remote')).toBe(true);
});

it.sequential('shell execute bypasses sandbox when disabled', async () => {
  let sandboxWrapped = false;
  let executedCommand: string | undefined;
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': false }),
    shellSandboxRunner: createFakeSandboxRunner({
      wrap: async () => {
        sandboxWrapped = true;
        return { command: 'sandboxed' };
      },
    }),
    executeShellCommandImpl: async (command) => {
      executedCommand = command;
      return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
    },
  });

  await tool.execute({ command: 'pwd', sandbox: 'default' });

  expect(sandboxWrapped).toBe(false);
  expect(executedCommand).toBe('pwd');
});

it('shell needsApproval prompts for default commands when sandbox is unavailable', async () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner({
      availability: async () => ({ type: 'unsupported_platform', reason: 'not supported' }),
    }),
  });

  expect(await tool.needsApproval({ command: 'pwd', sandbox: 'default' })).toBe(true);
});

it.sequential('shell execute fails closed when sandbox availability degrades after approval', async () => {
  let availabilityChecks = 0;
  let sandboxWrapped = false;
  let executeCalled = false;
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner({
      availability: async () => {
        availabilityChecks += 1;
        return availabilityChecks === 1
          ? { type: 'available' }
          : { type: 'unsupported_platform', reason: 'not supported' };
      },
      wrap: async () => {
        sandboxWrapped = true;
        return { command: 'sandboxed' };
      },
    }),
    executeShellCommandImpl: async () => {
      executeCalled = true;
      return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
    },
  });

  // The command is auto-approved while the sandbox is available.
  expect(await tool.needsApproval({ command: 'pwd', sandbox: 'default' })).toBe(false);

  const output = await tool.execute({ command: 'pwd', sandbox: 'default' });

  expect(sandboxWrapped).toBe(false);
  expect(executeCalled).toBe(false);
  expect(output).toContain('Sandbox blocked this command');
  expect(output).toContain('sandbox="unsandboxed"');
});

it.sequential('shell execute fails closed when sandbox wrapping fails', async () => {
  let executedCommand: string | undefined;
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner({
      wrap: async () => {
        throw new Error('init failed');
      },
    }),
    executeShellCommandImpl: async (command) => {
      executedCommand = command;
      return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
    },
  });

  const output = await tool.execute({ command: 'pwd', sandbox: 'default' });

  expect(executedCommand).toBeUndefined();
  expect(output).toContain('Sandbox blocked this command');
  expect(output).toContain('sandbox="unsandboxed"');
});

it.sequential('shell execute appends retry instruction when sandbox annotates a denial', async () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner({
      annotateFailure: (_command: string, stderr: string) => `${stderr}\nSandbox violation: network denied`,
    }),
    executeShellCommandImpl: async () => ({
      stdout: '',
      stderr: 'curl: failed',
      exitCode: 1,
      timedOut: false,
    }),
  });

  const output = await tool.execute({ command: 'curl https://example.com', sandbox: 'default' });

  expect(output.includes('Sandbox violation: network denied')).toBe(true);
  expect(output.includes('Sandbox blocked this command')).toBe(true);
  expect(output.includes('sandbox="unsandboxed"')).toBe(true);
});

it.sequential(
  'shell execute appends retry instruction for proxy allowlist blocks without sandbox annotation',
  async () => {
    const tool = createShellToolDefinition({
      loggingService: createNoopLogger(),
      settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
      shellSandboxRunner: createFakeSandboxRunner(),
      executeShellCommandImpl: async () => ({
        stdout: '',
        stderr: 'HTTP/1.1 403 Forbidden\nblocked-by-allowlist',
        exitCode: 1,
        timedOut: false,
      }),
    });

    const output = await tool.execute({ command: 'curl https://not-allowed.example', sandbox: 'default' });

    expect(output.includes('blocked-by-allowlist')).toBe(true);
    expect(output.includes('Sandbox blocked this command')).toBe(true);
    expect(output.includes('sandbox="unsandboxed"')).toBe(true);
  },
);

it.sequential('shell execute in plan mode blocks mutating commands but runs green commands', async () => {
  const settingsService = createMockSettingsService({
    'app.planMode': true,
    'sandbox.enabled': false,
  });

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService,
  });

  // Mutating command: touch (normally returns error directly without running)
  const outputMutating = await tool.execute({
    command: 'touch /tmp/somefile_plan_mode_test',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(outputMutating.includes('plan mode is read-only')).toBe(true);
  expect(outputMutating.includes('Command not executed')).toBe(true);

  // Green command: echo hello
  const outputGreen = await tool.execute({
    command: 'echo hello_plan_mode_test',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(outputGreen.includes('hello_plan_mode_test')).toBe(true);
  expect(outputGreen.includes('exit 0')).toBe(true);
});

it.sequential('shell needsApproval classifications in planMode false', async () => {
  const settingsService = createMockSettingsService({
    'app.planMode': false,
    'sandbox.enabled': false,
  });

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService,
  });

  expect(await tool.needsApproval({ command: 'touch /tmp/somefile_test' })).toBe(true);
  expect(await tool.needsApproval({ command: 'ls' })).toBe(false);
});

beforeEach(() => {
  resetSandboxDeniedReadStoresForTest();
});

afterEach(() => {
  resetSandboxDeniedReadStoresForTest();
});

it.sequential('shell needsApproval returns true when a denied-read entry is pending', async () => {
  const nestedCompatibility = createNestedCompatibility();
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner(),
    nestedCompatibility,
  });

  // Without a pending denied-read, a default sandboxed command is auto-approved.
  expect(await tool.needsApproval({ command: 'cargo build', sandbox: 'default' })).toBe(false);

  // Record a denied-read for this command — now the retry must require approval.
  nestedCompatibility.deniedReads.record('cargo build', {
    path: '/home/testuser/.cargo/registry/cache',
    suggestedParent: '/home/testuser/.cargo',
    sensitive: false,
  });
  expect(await tool.needsApproval({ command: 'cargo build', sandbox: 'default' })).toBe(true);
});

it.sequential('shell execute detects denied reads under strict and returns retry instruction', async () => {
  let executedCommand: string | undefined;
  const nestedCompatibility = createNestedCompatibility();
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({
      'sandbox.enabled': true,
      'sandbox.readPolicy': 'strict',
    }),
    shellSandboxRunner: createFakeSandboxRunner({
      annotateFailure: (_command: string, stderr: string) =>
        `${stderr}\n<sandbox_violations>\nSandbox: cat(123) deny file-read* /home/testuser/.cargo/registry/cache\n</sandbox_violations>`,
    }),
    executeShellCommandImpl: async (command) => {
      executedCommand = command;
      return { stdout: '', stderr: 'cat: error', exitCode: 1, timedOut: false };
    },
    nestedCompatibility,
  });

  const output = await tool.execute({ command: 'cat ~/.cargo/registry/cache', sandbox: 'default' });

  // The denied-read detector records the info and returns the retry instruction.
  expect(output.toLowerCase()).toContain('retry');
  expect(output).not.toContain('sandbox="unsandboxed"');
  expect(nestedCompatibility.deniedReads.peek('cat ~/.cargo/registry/cache')).not.toBeNull();
  // The denied-read entry should have the resolved path and suggested parent.
  const info = nestedCompatibility.deniedReads.peek('cat ~/.cargo/registry/cache');
  expect(info?.path).toBe('/home/testuser/.cargo/registry/cache');
  expect(info?.sensitive).toBe(false);
});

it.sequential('shell records a denied read under the raw command so a cd-prefixed retry still prompts', async () => {
  const cwd = process.cwd();
  // The model commonly re-states the cwd it is already in; `stripRedundantCd`
  // rewrites this before execution, so the recorded key must still be the raw
  // string the model emitted — that is the only key the approval lookups have.
  const rawCommand = `cd ${cwd} && cargo build`;
  let executedCommand: string | undefined;
  const nestedCompatibility = createNestedCompatibility();

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({
      'sandbox.enabled': true,
      'sandbox.readPolicy': 'strict',
    }),
    shellSandboxRunner: createFakeSandboxRunner({
      annotateFailure: (_command: string, stderr: string) =>
        `${stderr}\n<sandbox_violations>\nSandbox: cargo(123) deny file-read* /home/testuser/.cargo/registry/cache\n</sandbox_violations>`,
    }),
    executeShellCommandImpl: async (command: string) => {
      executedCommand = command;
      return { stdout: '', stderr: 'cargo: error', exitCode: 1, timedOut: false };
    },
    nestedCompatibility,
  });

  const output = await tool.execute({ command: rawCommand, sandbox: 'default' });
  expect(output.toLowerCase()).toContain('retry');

  // Precondition guard: the redundant `cd` really was stripped, so the executed
  // command and the model-emitted command genuinely differ.
  expect(executedCommand).not.toContain('cd ');

  // Both approval lookups key off the raw model-emitted command. The conversation
  // layer has no cwd, so it cannot re-derive the stripped form.
  expect(nestedCompatibility.deniedReads.has(rawCommand)).toBe(true);
  expect(await tool.needsApproval({ command: rawCommand, sandbox: 'default' })).toBe(true);
});

it.sequential('shell execute detects hidden existing home paths reported as no-such-file under strict', async () => {
  const target = path.join(os.homedir(), '.cache');
  const nestedCompatibility = createNestedCompatibility();
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({
      'sandbox.enabled': true,
      'sandbox.readPolicy': 'strict',
    }),
    shellSandboxRunner: createFakeSandboxRunner(),
    executeShellCommandImpl: async () => ({
      stdout: '',
      stderr: `/usr/bin/bash: line 1: ${target}: No such file or directory`,
      exitCode: 127,
      timedOut: false,
    }),
    nestedCompatibility,
  });

  const output = await tool.execute({ command: target, sandbox: 'default' });

  expect(output.toLowerCase()).toContain('retry');
  expect(nestedCompatibility.deniedReads.peek(target)).not.toBeNull();
});

it.sequential('shell execute does not detect denied reads under standard (V1 compatibility)', async () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({
      'sandbox.enabled': true,
      'sandbox.readPolicy': 'standard',
    }),
    shellSandboxRunner: createFakeSandboxRunner({
      annotateFailure: (_command: string, stderr: string) =>
        `${stderr}\n<sandbox_violations>\nSandbox: cat(123) deny file-read* /home/testuser/.cargo/registry/cache\n</sandbox_violations>`,
    }),
    executeShellCommandImpl: async () => ({
      stdout: '',
      stderr: 'cat: error',
      exitCode: 1,
      timedOut: false,
    }),
  });

  const output = await tool.execute({ command: 'cat ~/.cargo/registry/cache', sandbox: 'default' });

  // No denied-read detection under standard — falls through to escape instruction.
  expect(output).toContain('sandbox="unsandboxed"');
  expect(deniedReadStore.peek('cat ~/.cargo/registry/cache')).toBeNull();
});

it.sequential('shell execute consumes forceUnsandboxed override and skips sandbox', async () => {
  let sandboxWrapped = false;
  let executedCommand: string | undefined;
  let receivedEnv: NodeJS.ProcessEnv | undefined;
  const nestedCompatibility = createNestedCompatibility();
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner({
      wrap: async () => {
        sandboxWrapped = true;
        return { command: 'sandboxed' };
      },
    }),
    executeShellCommandImpl: async (command, options) => {
      executedCommand = command;
      receivedEnv = options?.env;
      return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
    },
    nestedCompatibility,
  });

  // Set a force-unsandboxed override (mocks a denied-read approval decision).
  nestedCompatibility.executionOverrides.set('cargo build', { forceUnsandboxed: true });

  await tool.execute({ command: 'cargo build', sandbox: 'default' });

  expect(sandboxWrapped).toBe(false);
  expect(executedCommand).toBe('cargo build');
  // Unsanctioned apps run with full env (env: undefined).
  expect(receivedEnv).toBeUndefined();
  // Override is consumed (one-shot).
  expect(nestedCompatibility.executionOverrides.consume('cargo build')).toBeNull();
});

it.sequential('shell execute consumes extraAllowRead override and merges into sandbox config', async () => {
  let receivedAllowRead: string[] | undefined;
  const nestedCompatibility = createNestedCompatibility();
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({
      'sandbox.enabled': true,
      'sandbox.readPolicy': 'strict',
      'sandbox.allowReadExtra': ['/tmp/global-extra'],
    }),
    shellSandboxRunner: createFakeSandboxRunner({
      wrap: async (_command: string, options: any) => {
        receivedAllowRead = options.config?.filesystem?.allowRead;
        return { command: 'sandboxed' };
      },
    }),
    executeShellCommandImpl: async () => ({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }),
    nestedCompatibility,
  });

  // Set an extraAllowRead override (mocks a denied-read "allow once" decision).
  nestedCompatibility.executionOverrides.set('cargo build', {
    extraAllowRead: ['/home/testuser/.cargo'],
  });

  await tool.execute({ command: 'cargo build', sandbox: 'default' });

  // The override path is merged into allowRead alongside settings + project paths.
  expect(receivedAllowRead).toBeDefined();
  expect(receivedAllowRead).toContain('/home/testuser/.cargo');
  expect(receivedAllowRead).toContain('/tmp/global-extra');
  // Override is consumed (one-shot).
  expect(nestedCompatibility.executionOverrides.consume('cargo build')).toBeNull();
});

it.sequential('root shell exposes denied-read metadata and re-executes only its held call override', async () => {
  let executions = 0;
  let allowRead: string[] | undefined;
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true, 'sandbox.readPolicy': 'strict' }),
    postExecuteDeniedRead: true,
    shellSandboxRunner: createFakeSandboxRunner({
      wrap: async (_command: string, options: any) => {
        allowRead = options.config?.filesystem?.allowRead;
        return { command: 'sandboxed' };
      },
      annotateFailure: (_command: string, stderr: string) =>
        `${stderr}\n<sandbox_violations>\nSandbox: cat(123) deny file-read* /home/testuser/.cargo/registry/cache\n</sandbox_violations>`,
    }),
    executeShellCommandImpl: async () => {
      executions++;
      return executions === 1
        ? {
            stdout: '',
            stderr: 'Sandbox: cat(123) deny file-read* /home/testuser/.cargo/registry/cache',
            exitCode: 1,
            timedOut: false,
          }
        : { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
    },
  });
  const details = { toolCall: { callId: 'call-root-denied' } };
  const first = await tool.execute({ command: 'cat ~/.cargo/registry/cache' }, undefined, details);
  const descriptor = tool.postExecutePause!.describe({ command: 'cat ~/.cargo/registry/cache' }, first, details)!;
  expect(descriptor.deniedRead).toMatchObject({ deniedPath: '/home/testuser/.cargo/registry/cache', sensitive: false });
  await tool.postExecutePause!.resolve!(
    {
      params: { command: 'cat ~/.cargo/registry/cache' },
      result: first,
      details,
      executeAgain: () => tool.execute({ command: 'cat ~/.cargo/registry/cache' }, undefined, details),
    },
    'allow-once',
  );
  expect(executions).toBe(2);
  expect(allowRead).toContain(descriptor.deniedRead!.suggestedParent);
  expect(deniedReadStore.has('cat ~/.cargo/registry/cache')).toBe(false);
});

it.sequential('root shell fails closed when a denied read has no SDK call ID', async () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true, 'sandbox.readPolicy': 'strict' }),
    postExecuteDeniedRead: true,
    shellSandboxRunner: createFakeSandboxRunner({
      annotateFailure: (_command: string, stderr: string) =>
        `${stderr}\n<sandbox_violations>\nSandbox: cat(123) deny file-read* /home/testuser/.cargo/registry/cache\n</sandbox_violations>`,
    }),
    executeShellCommandImpl: async () => ({
      stdout: '',
      stderr: 'Sandbox: cat(123) deny file-read* /home/testuser/.cargo/registry/cache',
      exitCode: 1,
      timedOut: false,
    }),
  });

  await expect(tool.execute({ command: 'cat ~/.cargo/registry/cache' })).rejects.toThrow(
    'requires an SDK tool call ID',
  );
  expect(deniedReadStore.has('cat ~/.cargo/registry/cache')).toBe(false);
});
