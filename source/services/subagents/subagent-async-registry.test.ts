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
