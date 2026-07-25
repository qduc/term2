import { it, expect } from 'vitest';
import { SubagentAsyncRegistry } from './subagent-async-registry.js';
import { SubagentSession } from './subagent-session.js';
import type { SubagentRequest, SubagentResult } from './types.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { createMockLogger } from './test-helpers/subagent-manager-fixtures.js';

function createRegistry(
  options: {
    run?: (params: { request: SubagentRequest; runId: string; signal?: AbortSignal }) => Promise<SubagentResult>;
    onEvent?: (event: ConversationEvent) => void;
  } = {},
): SubagentAsyncRegistry {
  const run =
    options.run ??
    (async ({ request }) =>
      ({
        agentId: 'unused',
        role: request.role,
        status: 'completed',
        finalText: 'async result',
        filesChanged: [],
        toolsUsed: [],
      } as SubagentResult));

  return new SubagentAsyncRegistry({
    logger: createMockLogger(),
    run,
    onEvent: options.onEvent,
  });
}

function completedResult(role: string, finalText: string): SubagentResult {
  return {
    agentId: 'unused',
    role,
    status: 'completed',
    finalText,
    filesChanged: [],
    toolsUsed: [],
  };
}

it('startRun returns a handle with runId, role, and task', async () => {
  const registry = createRegistry();
  const handle = registry.startRun({ role: 'explorer', task: 'find files' });

  expect(handle.runId).toBeTruthy();
  expect(handle.role).toBe('explorer');
  expect(handle.task).toBe('find files');
  expect(handle.status).toBe('running');
  expect(handle.session).toBeInstanceOf(SubagentSession);
  expect(handle.session.role).toBe('explorer');
});

it('startRun emits a subagent_started event with async flag', async () => {
  const events: ConversationEvent[] = [];
  const registry = createRegistry({ onEvent: (e) => events.push(e) });

  const handle = registry.startRun({ role: 'explorer', task: 'find files' });

  const started = events.find((e) => e.type === 'subagent_started');
  expect(started).toBeTruthy();
  expect(started!.type).toBe('subagent_started');
  expect((started as any).agentId).toBe(handle.runId);
  expect((started as any).role).toBe('explorer');
  expect((started as any).task).toBe('find files');
  expect((started as any).async).toBe(true);
});

it('getResult resolves to the SubagentResult when the run completes', async () => {
  const registry = createRegistry();
  const handle = registry.startRun({ role: 'explorer', task: 'find files' });

  const result = await registry.getResult(handle.runId);

  expect(result.status).toBe('completed');
  expect(result.role).toBe('explorer');
  expect(result.agentId).toBe(handle.runId);
  expect(result.finalText).toBe('async result');
});

it('handle status transitions to completed when the run finishes', async () => {
  const registry = createRegistry();
  const handle = registry.startRun({ role: 'explorer', task: 'find files' });

  await registry.getResult(handle.runId);

  expect(handle.status).toBe('completed');
  expect(handle.result).toBeTruthy();
});

it('getResult rejects when the runId is unknown', async () => {
  const registry = createRegistry();

  await expect(registry.getResult('unknown-run-id')).rejects.toThrow('Unknown async subagent run');
});

it('Phase 1 rejects worker and librarian roles', async () => {
  const registry = createRegistry();

  for (const role of ['worker', 'librarian']) {
    const handle = registry.startRun({ role: role as any, task: 'do work' });
    expect(handle.status).toBe('failed');
    expect(handle.error).toMatch(/not supported.*Phase 1/i);
  }
});

it('rejects unknown subagent roles', async () => {
  const registry = createRegistry();

  const handle = registry.startRun({ role: 'unknown-role', task: 'do work' } as SubagentRequest);
  expect(handle.status).toBe('failed');
  expect(handle.error).toMatch(/Unknown subagent role|not supported/i);
});

it('parent abort signal cancels an async run', async () => {
  const abortController = new AbortController();
  let capturedSignal: AbortSignal | undefined;
  const registry = createRegistry({
    run: async ({ signal }) => {
      capturedSignal = signal;
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });

  const handle = registry.startRun({ role: 'explorer', task: 'slow task' }, abortController.signal);

  abortController.abort();

  await expect(registry.getResult(handle.runId)).rejects.toThrow();
  expect(handle.status).toBe('cancelled');
  expect(capturedSignal?.aborted).toBe(true);
});

it('emits subagent_completed and subagent_async_progress when the run finishes', async () => {
  const events: ConversationEvent[] = [];
  const registry = createRegistry({ onEvent: (e) => events.push(e) });

  const handle = registry.startRun({ role: 'explorer', task: 'find files' });
  await registry.getResult(handle.runId);

  const completed = events.find((e) => e.type === 'subagent_completed');
  expect(completed).toBeTruthy();
  expect((completed as any).result.agentId).toBe(handle.runId);
  expect((completed as any).async).toBe(true);

  const progress = events.find((e) => e.type === 'subagent_async_progress');
  expect(progress).toBeTruthy();
  expect((progress as any).runId).toBe(handle.runId);
  expect((progress as any).status).toBe('completed');
});

it('mentor async runs use a fresh SubagentSession per run', async () => {
  const registry = createRegistry();

  const handle1 = registry.startRun({ role: 'mentor', task: 'first question' });
  const handle2 = registry.startRun({ role: 'mentor', task: 'second question' });

  expect(handle1.session).not.toBe(handle2.session);
  expect(handle1.session.id).not.toBe(handle2.session.id);
});

it('disposal aborts active runs', async () => {
  const registry = createRegistry({
    run: async ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  });
  const handle = registry.startRun({ role: 'explorer', task: 'long task' });

  registry.dispose();

  await expect(registry.getResult(handle.runId)).rejects.toThrow();
  expect(handle.status === 'cancelled' || handle.status === 'failed').toBe(true);
});

it('executor receives the correct runId and request', async () => {
  let captured: { request: SubagentRequest; runId: string; signal?: AbortSignal } | undefined;
  const parentSignal = new AbortController().signal;
  const registry = createRegistry({
    run: async (params) => {
      captured = params;
      return completedResult(params.request.role, 'done');
    },
  });

  const handle = registry.startRun({ role: 'researcher', task: 'look up docs' }, parentSignal);
  await registry.getResult(handle.runId);

  expect(captured).toBeTruthy();
  expect(captured!.runId).toBe(handle.runId);
  expect(captured!.request.role).toBe('researcher');
  expect(captured!.request.task).toBe('look up docs');
  expect(captured!.signal).toBeInstanceOf(AbortSignal);
  expect(captured!.signal!.aborted).toBe(false);
});

it('result agentId is overridden to match the runId', async () => {
  const registry = createRegistry({
    run: async ({ runId }) =>
      ({
        agentId: 'wrong-id',
        role: 'explorer',
        status: 'completed',
        finalText: 'done',
        filesChanged: [],
        toolsUsed: [],
      } as SubagentResult),
  });

  const handle = registry.startRun({ role: 'explorer', task: 'find files' });
  const result = await registry.getResult(handle.runId);

  expect(result.agentId).toBe(handle.runId);
});

it('cancelAllRuns aborts every running handle', async () => {
  const registry = createRegistry({
    run: async ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  });
  const handle1 = registry.startRun({ role: 'explorer', task: 'first' });
  const handle2 = registry.startRun({ role: 'researcher', task: 'second' });

  registry.cancelAllRuns();

  await expect(registry.getResult(handle1.runId)).rejects.toThrow();
  await expect(registry.getResult(handle2.runId)).rejects.toThrow();
  expect(handle1.status).toBe('cancelled');
  expect(handle2.status).toBe('cancelled');
});

it('completed promise settles when a run fails validation', async () => {
  const registry = createRegistry();

  const handle = registry.startRun({ role: 'worker', task: 'do work' } as SubagentRequest);

  await expect(handle.completed).rejects.toThrow(/not supported.*Phase 1/i);
  expect(handle.status).toBe('failed');
});

it('completed promise settles when the parent signal is already aborted', async () => {
  const registry = createRegistry();
  const abortController = new AbortController();
  abortController.abort();

  const handle = registry.startRun({ role: 'explorer', task: 'too late' }, abortController.signal);

  await expect(handle.completed).rejects.toThrow(/aborted before it started/i);
  expect(handle.status).toBe('cancelled');
});
