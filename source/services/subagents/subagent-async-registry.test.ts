import { describe, expect, it, vi } from 'vitest';
import { SubagentAsyncRegistry, SubagentRegistryError } from './subagent-async-registry.js';
import type { SubagentRequest, SubagentResult } from './types.js';
import type { SubagentSession } from './subagent-session.js';
import { createMockLogger } from './test-helpers/subagent-manager-fixtures.js';

const result = (role: string, status: SubagentResult['status'] = 'completed'): SubagentResult => ({
  agentId: 'executor-id',
  role,
  status,
  finalText: status === 'completed' ? 'done' : '',
  filesChanged: [],
  toolsUsed: [],
  ...(status !== 'completed' ? { error: status } : {}),
});
type RunParams = { request: SubagentRequest; session: SubagentSession; signal: AbortSignal };
const make = (run: (params: RunParams) => Promise<SubagentResult> = async ({ request }) => result(request.role)) =>
  new SubagentAsyncRegistry({ logger: createMockLogger(), run });

it('returns the exact running launch handle and executes with its owned session', async () => {
  let session: unknown;
  const registry = make(async ({ session: owned, request }) => {
    session = owned;
    return result(request.role);
  });
  const handle = registry.startRun({ role: 'explorer', task: 'inspect' });
  expect(handle).toEqual({ runId: expect.any(String), role: 'explorer', status: 'running', task: 'inspect' });
  await expect(registry.getResult(handle.runId)).resolves.toMatchObject({ status: 'completed' });
  expect(session).toBeTruthy();
});

it('reuses the same run id and session only for a completed continuation', async () => {
  const sessions: unknown[] = [];
  const registry = make(async ({ session, request }) => {
    sessions.push(session);
    return result(request.role);
  });
  const first = registry.startRun({ role: 'explorer', task: 'one' });
  await registry.getResult(first.runId);
  const second = registry.startRun({ role: 'explorer', task: 'two', continueRunId: first.runId });
  expect(second.runId).toBe(first.runId);
  await registry.getResult(second.runId);
  expect(sessions[0]).toBe(sessions[1]);
});

it('applies role continuation policy', async () => {
  const registry = make();
  const worker = registry.startRun({ role: 'worker', task: 'fresh' });
  await registry.getResult(worker.runId);
  expect(() => registry.startRun({ role: 'worker', task: 'again', continueRunId: worker.runId })).toThrowError(
    SubagentRegistryError,
  );
  expect(() => registry.startRun({ role: 'explorer', task: 'wrong', continueRunId: worker.runId })).toThrowError(
    /role/,
  );
});

it('explicit cancellation remains terminal when the executor resolves later', async () => {
  let resolve!: (value: SubagentResult) => void;
  const registry = make(() => new Promise<SubagentResult>((r) => (resolve = r)));
  const run = registry.startRun({ role: 'explorer', task: 'cancel me' });
  registry.cancelAllRuns();
  await expect(registry.getResult(run.runId)).resolves.toMatchObject({ status: 'cancelled' });
  resolve(result('explorer'));
  await new Promise((r) => setTimeout(r, 0));
  await expect(registry.getResult(run.runId)).resolves.toMatchObject({ status: 'cancelled' });
});

it('cancels a run when its parent signal aborts', async () => {
  const controller = new AbortController();
  const registry = make(
    ({ signal, request }) =>
      new Promise<SubagentResult>((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      ),
  );
  const run = registry.startRun({ role: 'researcher', task: 'parent', signal: controller.signal });
  controller.abort();
  await expect(registry.getResult(run.runId)).resolves.toMatchObject({ status: 'cancelled' });
});

it('rejects a fresh run targeting an active shared session', () => {
  const registry = make(() => new Promise<SubagentResult>(() => undefined));
  registry.startRun({ role: 'mentor', task: 'one' });
  expect(() => registry.startRun({ role: 'mentor', task: 'two' })).toThrowError(/already active/);
});

it('returns terminal failures and cancellations instead of rejecting', async () => {
  const failed = make(async ({ request }) => result(request.role, 'failed'));
  const failedRun = failed.startRun({ role: 'researcher', task: 'fail' });
  await expect(failed.getResult(failedRun.runId)).resolves.toMatchObject({ status: 'failed' });
  const cancelled = make(
    ({ signal, request }) =>
      new Promise<SubagentResult>((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      ),
  );
  const cancelledRun = cancelled.startRun({ role: 'explorer', task: 'cancel' });
  cancelled.abortRun(cancelledRun.runId);
  await expect(cancelled.getResult(cancelledRun.runId)).resolves.toMatchObject({ status: 'cancelled' });
});

it('evicts terminal runs from an injected clock and refreshes TTL on access', async () => {
  let now = 0;
  let tick!: () => void;
  let cleared = false;
  const registry = new SubagentAsyncRegistry({
    logger: createMockLogger(),
    now: () => now,
    ttlMs: 1_800_000,
    setInterval: (callback) => {
      tick = callback;
      return 1 as any;
    },
    clearInterval: () => {
      cleared = true;
    },
    run: async ({ request }) => result(request.role),
  });
  const run = registry.startRun({ role: 'explorer', task: 'inspect' });
  await registry.getResult(run.runId);
  now = 1_700_000;
  await registry.getResult(run.runId);
  now = 3_500_001;
  tick();
  await expect(registry.getResult(run.runId)).rejects.toMatchObject({ code: 'evicted' });
  registry.dispose();
  expect(cleared).toBe(true);
});

it('preserves terminal cancellation when disposed during execution', async () => {
  let resolve!: (value: SubagentResult) => void;
  const registry = new SubagentAsyncRegistry({
    logger: createMockLogger(),
    setInterval: () => 1 as any,
    clearInterval: () => {},
    run: () => new Promise<SubagentResult>((r) => (resolve = r)),
  });
  const run = registry.startRun({ role: 'explorer', task: 'cancel' });
  const resultPromise = registry.getResult(run.runId);
  registry.dispose();
  await expect(resultPromise).resolves.toMatchObject({ status: 'cancelled' });
  resolve(result('explorer'));
});

it('reports typed not-found, active, worker, and evicted errors', async () => {
  const now = vi.fn(() => 0);
  const registry = new SubagentAsyncRegistry({
    logger: createMockLogger(),
    now,
    ttlMs: 10,
    run: async ({ request }) => result(request.role),
  });
  expect(() => registry.startRun({ role: 'explorer', task: 'x', continueRunId: 'missing' })).toThrowError(/not found/);
  const run = registry.startRun({ role: 'worker', task: 'x' });
  expect(() => registry.startRun({ role: 'worker', task: 'y', continueRunId: run.runId })).toThrowError(/active/);
  await registry.getResult(run.runId);
  expect(() => registry.startRun({ role: 'worker', task: 'y', continueRunId: run.runId })).toThrowError(/worker/i);
  now.mockReturnValue(11);
  registry.dispose();
});

describe('peek / getRunStatus', () => {
  it('returns running status with startedAt and empty toolCounts before any tool fires', async () => {
    const now = vi.fn(() => 5000);
    const registry = new SubagentAsyncRegistry({
      logger: createMockLogger(),
      now,
      setInterval: () => 1 as any,
      clearInterval: () => {},
      run: () => new Promise<SubagentResult>(() => undefined),
    });
    const handle = registry.startRun({ role: 'explorer', task: 'inspect' });
    const status = registry.getRunStatus(handle.runId) as any;
    expect(status).toMatchObject({
      runId: handle.runId,
      role: 'explorer',
      status: 'running',
      task: 'inspect',
      startedAt: 5000,
      toolCounts: {},
    });
    expect(status.elapsedMs).toBe(0);
    expect(status.lastToolName).toBeUndefined();
    registry.dispose();
  });

  it('captures lastToolName and toolCounts from subagent_tool_started events it owns', async () => {
    const now = vi.fn(() => 1000);
    const events: any[] = [];
    const registry = new SubagentAsyncRegistry({
      logger: createMockLogger(),
      now,
      setInterval: () => 1 as any,
      clearInterval: () => {},
      onEvent: (e) => events.push(e),
      run: () => new Promise<SubagentResult>(() => undefined),
    });
    const handle = registry.startRun({ role: 'worker', task: 'edit' });
    registry.handleSubagentEvent({
      type: 'subagent_tool_started',
      agentId: handle.runId,
      role: 'worker',
      toolCallId: 'tc1',
      toolName: 'search_replace',
      arguments: {},
    });
    now.mockReturnValue(1500);
    registry.handleSubagentEvent({
      type: 'subagent_tool_started',
      agentId: handle.runId,
      role: 'worker',
      toolCallId: 'tc2',
      toolName: 'search_replace',
      arguments: {},
    });
    const status = registry.getRunStatus(handle.runId) as any;
    expect(status.lastToolName).toBe('search_replace');
    expect(status.lastToolAt).toBe(1500);
    expect(status.toolCounts).toEqual({ search_replace: 2 });
    expect(status.elapsedMs).toBe(500);
    registry.dispose();
  });

  it('handleSubagentEvent is a no-op for an agentId it does not own', () => {
    const registry = make(() => new Promise<SubagentResult>(() => undefined));
    const handle = registry.startRun({ role: 'explorer', task: 'mine' });
    registry.handleSubagentEvent({
      type: 'subagent_tool_started',
      agentId: 'not-a-real-run-id',
      role: 'explorer',
      toolName: 'read_file',
      arguments: {},
    } as any);
    const status = registry.getRunStatus(handle.runId) as any;
    expect(status.toolCounts).toEqual({});
    expect(status.lastToolName).toBeUndefined();
    registry.dispose();
  });

  it('getRunStatus for an unknown id returns a not-found sentinel, not a throw', () => {
    const registry = make(() => new Promise<SubagentResult>(() => undefined));
    const status = registry.getRunStatus('does-not-exist');
    expect(status).toMatchObject({ runId: 'does-not-exist', status: 'not_found' });
    registry.dispose();
  });

  it('getRunStatus() with no id lists live runs first, without finalText', async () => {
    const now = vi.fn(() => 0);
    const registry = new SubagentAsyncRegistry({
      logger: createMockLogger(),
      now,
      setInterval: () => 1 as any,
      clearInterval: () => {},
      // Worker stays pending (live); explorer resolves immediately (finished).
      run: async ({ request }) =>
        request.role === 'worker' ? new Promise<SubagentResult>(() => undefined) : result(request.role),
    });
    const live = registry.startRun({ role: 'worker', task: 'running task' });
    const finished = registry.startRun({ role: 'explorer', task: 'done task' });
    await registry.getResult(finished.runId);
    now.mockReturnValue(1000);
    const list = registry.getRunStatus() as any[];
    expect(Array.isArray(list)).toBe(true);
    const liveEntry = list.find((s) => s.runId === live.runId);
    const finishedEntry = list.find((s) => s.runId === finished.runId);
    expect(liveEntry.status).toBe('running');
    expect(finishedEntry.status).toBe('completed');
    expect(liveEntry.finalText).toBeUndefined();
    expect(finishedEntry.finalText).toBeUndefined();
    registry.dispose();
  });

  it('getRunStatus is synchronous and does not await the run promise', async () => {
    const registry = make(() => new Promise<SubagentResult>(() => undefined));
    const handle = registry.startRun({ role: 'explorer', task: 'blocking' });
    // Non-blocking: returns immediately even though the run never settles.
    let returned = false;
    const status = registry.getRunStatus(handle.runId);
    returned = true;
    expect(returned).toBe(true);
    expect((status as any).status).toBe('running');
    registry.dispose();
  });
});

describe('retention and events', () => {
  it('buffers ordered events at the bridge-facing callback and retains terminal records until reset', async () => {
    const events: string[] = [];
    const registry = new SubagentAsyncRegistry({
      logger: createMockLogger(),
      onEvent: (event) => events.push(event.type),
      run: async ({ request }) => result(request.role),
    });
    const run = registry.startRun({ role: 'mentor', task: 'question' });
    await registry.getResult(run.runId);
    expect(events).toEqual(['subagent_started', 'subagent_completed']);
    registry.reset();
    await expect(registry.getResult(run.runId)).rejects.toThrow();
    registry.dispose();
  });
});
