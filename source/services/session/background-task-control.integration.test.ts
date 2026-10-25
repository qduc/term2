import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { BackgroundTaskControl } from './background-task-control.js';
import { BackgroundShellRegistry } from '../shell/background-shell-registry.js';

const registries: BackgroundShellRegistry<unknown>[] = [];
const capacityReleases: (() => void)[] = [];
afterEach(async () => {
  for (const release of capacityReleases.splice(0)) release();
  await Promise.all(registries.splice(0).map((registry) => registry.dispose()));
});

class RegistryClient {
  #registry: BackgroundShellRegistry<unknown>;
  #subagentCapacity = false;
  #subagents = new Map<string, { runId: string; role: string; task: string; startedAt: number }>();

  constructor(registry: BackgroundShellRegistry<unknown>) {
    this.#registry = registry;
  }
  getForegroundShellTransferCandidate() {
    return this.#registry.listForeground()[0];
  }
  moveForegroundShellToBackground(callId: string) {
    return this.#registry.adoptForeground(callId);
  }
  getBackgroundShellJob(id: string) {
    return this.#registry.get(id);
  }
  listBackgroundShellJobs() {
    return this.#registry.list();
  }
  listForegroundSubagentCandidates() {
    return [...this.#subagents.values()];
  }
  moveForegroundSubagent(runId: string) {
    const candidate = this.#subagents.get(runId);
    if (!candidate) return undefined;
    if (this.#subagentCapacity) {
      const error = new Error('subagent capacity');
      error.name = 'SubagentRegistryError';
      throw error;
    }
    this.#subagents.delete(runId);
    this.#subagents.set(runId, candidate);
    return candidate;
  }
  getBackgroundSubagentStatus(runId: string) {
    const candidate = this.#subagents.get(runId);
    return candidate
      ? { ...candidate, taskPreview: candidate.task, status: 'running' as const, elapsedMs: 0, toolCounts: {} }
      : { status: 'not_found' as const };
  }
  listBackgroundSubagentStatuses() {
    return [...this.#subagents.keys()].map((runId) => this.getBackgroundSubagentStatus(runId));
  }
  addSubagent(runId: string) {
    this.#subagents.set(runId, { runId, role: 'worker', task: 'work', startedAt: 1 });
  }
  setSubagentCapacity(value: boolean) {
    this.#subagentCapacity = value;
  }
}

const makeControl = (client: RegistryClient) =>
  new BackgroundTaskControl({
    client: client as never,
    notifications: { enqueueUserControl: () => true } as never,
  });

const startChild = (signal: AbortSignal): Promise<{ output: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', "setTimeout(() => process.stdout.write('done'), 60000)"], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    const abort = () => child.kill();
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      resolve({ output });
    });
  });

describe('foreground task control across the shell registry boundary', () => {
  it('adopts a live child-process lease and exposes the transitioned background job', async () => {
    const registry = new BackgroundShellRegistry({ createId: () => 'job-real', maxConcurrentJobs: 2 });
    registries.push(registry);
    const lease = registry.startForeground({ callId: 'call-real', command: 'local child', run: startChild });
    const client = new RegistryClient(registry);
    const control = makeControl(client);

    expect(control.moveForegroundToBackground({ kind: 'shell', callId: 'call-real' })).toMatchObject({
      ok: true,
      details: { kind: 'shell', id: 'job-real', command: 'local child', status: 'running' },
    });
    expect(registry.getForeground('call-real')).toBeUndefined();
    expect(registry.get('job-real')).toMatchObject({ id: 'job-real', status: 'running' });
    await expect(lease.foregroundResult).resolves.toEqual({ jobId: 'job-real', status: 'running' });

    client.addSubagent('run-real');
    expect(control.moveForegroundToBackground({ kind: 'subagent', runId: 'run-real' })).toMatchObject({
      ok: true,
      details: { kind: 'subagent', id: 'run-real', status: 'running' },
    });
    client.setSubagentCapacity(true);
    expect(control.moveForegroundToBackground({ kind: 'subagent', runId: 'run-real' })).toEqual({
      ok: false,
      code: 'capacity',
    });
    expect(control.moveForegroundToBackground({ kind: 'subagent', runId: 'missing' })).toEqual({
      ok: false,
      code: 'not_found',
    });
  });

  it('maps the real registry capacity error without adopting the foreground lease', () => {
    const registry = new BackgroundShellRegistry({ createId: () => 'job-capacity', maxConcurrentJobs: 1 });
    registries.push(registry);
    let release!: () => void;
    const occupied = new Promise<void>((resolve) => (release = resolve));
    capacityReleases.push(release);
    registry.launch({ command: 'occupy capacity', run: () => occupied });
    registry.startForeground({ callId: 'call-full', command: 'waiting lease', run: startChild });
    const control = makeControl(new RegistryClient(registry));

    expect(control.moveForegroundToBackground({ kind: 'shell', callId: 'call-full' })).toEqual({
      ok: false,
      code: 'capacity',
    });
    expect(registry.getForeground('call-full')).toBeDefined();
    expect(registry.list()).toHaveLength(1);
    expect(control.moveForegroundToBackground({ kind: 'shell', callId: 'missing' })).toEqual({
      ok: false,
      code: 'not_found',
    });
  });

  it('reports unavailable when the client does not expose transfer capabilities', () => {
    const control = new BackgroundTaskControl({
      client: {} as never,
      notifications: { enqueueUserControl: () => true } as never,
    });
    expect(control.moveForegroundToBackground({ kind: 'shell', callId: 'missing' })).toEqual({
      ok: false,
      code: 'unavailable',
    });
    expect(control.moveForegroundToBackground({ kind: 'subagent', runId: 'missing' })).toEqual({
      ok: false,
      code: 'unavailable',
    });
  });
});
