import { describe, expect, it, vi } from 'vitest';
import { CODENAME_RUN_ID_PATTERN } from './codename-run-id.js';
import { SubagentAsyncRegistry, SubagentRegistryError } from './subagent-async-registry.js';
import type { SubagentRequest, SubagentResult } from './types.js';
import type { SubagentSession } from './subagent-session.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { AgentClient } from '../../lib/agent-client.js';
import { createSubagentRuntime } from './runtime.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import {
  createMockLogger,
  createMockSettings,
  createSessionContextService,
  registerTestProvider,
  wrapResultAsAgentStream,
} from './test-helpers/subagent-manager-fixtures.js';

const result = (role: string, status: SubagentResult['status'] = 'completed'): SubagentResult => ({
  agentId: 'executor-id',
  role,
  status,
  finalText: status === 'completed' ? 'done' : '',
  filesChanged: [],
  toolsUsed: [],
  ...(status !== 'completed' ? { error: status } : {}),
});
type RunParams = {
  request: SubagentRequest;
  runId: string;
  session: SubagentSession;
  signal: AbortSignal;
  input: string;
  control: { onToolStart(): void; onToolComplete(): void; askOrchestrator(question: string): Promise<string> };
};
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

it('returns an active name in the handle and status snapshot', async () => {
  const registry = make(() => new Promise<SubagentResult>(() => undefined));

  const handle = registry.startRun({ role: 'explorer', task: 'inspect', name: 'code_scan' });

  expect(handle).toMatchObject({ runId: expect.any(String), name: 'code_scan', status: 'running' });
  expect(registry.getRunStatus(handle.runId)).toMatchObject({ runId: handle.runId, name: 'code_scan' });
  registry.dispose();
});

it('rejects invalid and already active run names with typed registry errors', () => {
  const registry = make(() => new Promise<SubagentResult>(() => undefined));

  expect(() => registry.startRun({ role: 'explorer', task: 'inspect', name: 'Uppercase' })).toThrowError(
    expect.objectContaining({ code: 'invalid_name' }),
  );
  registry.startRun({ role: 'explorer', task: 'inspect', name: 'code_scan' });
  expect(() => registry.startRun({ role: 'explorer', task: 'research', name: 'code_scan' })).toThrowError(
    expect.objectContaining({ code: 'name_in_use' }),
  );
  registry.dispose();
});

it.each(['completed', 'failed', 'cancelled'] as const)(
  'makes a name reusable after a %s terminal settlement',
  async (status) => {
    const registry = make(async ({ request }) => result(request.role, status));
    const first = registry.startRun({ role: 'explorer', task: 'first', name: 'reusable' });
    await registry.getResult(first.runId);
    expect(registry.getRunStatus(first.runId)).toMatchObject({ name: 'reusable', status });

    const second = registry.startRun({ role: 'explorer', task: 'second', name: 'reusable' });

    expect(second.name).toBe('reusable');
    registry.dispose();
  },
);

it('reserves a cancelling name and settles only after partial runner evidence arrives', async () => {
  let resolve!: (value: SubagentResult) => void;
  const events: string[] = [];
  const registry = new SubagentAsyncRegistry({
    logger: createMockLogger(),
    onEvent: (event) => events.push(event.type),
    run: () => new Promise<SubagentResult>((r) => (resolve = r)),
  });
  const first = registry.startRun({ role: 'explorer', task: 'first', name: 'reusable' });
  const resultPromise = registry.getResult(first.runId);
  let settled = false;
  void resultPromise.then(() => {
    settled = true;
  });

  registry.abortRun(first.runId);
  await Promise.resolve();

  expect(registry.getRunStatus(first.runId)).toMatchObject({ status: 'cancelling' });
  expect(settled).toBe(false);
  expect(() => registry.startRun({ role: 'explorer', task: 'second', name: 'reusable' })).toThrowError(
    expect.objectContaining({ code: 'name_in_use' }),
  );
  expect(events).toEqual(['subagent_started']);

  resolve({
    ...result('explorer'),
    filesChanged: ['source/changed.ts'],
    toolsUsed: [{ toolName: 'write_file', count: 1 }],
    diffStat: [{ path: 'source/changed.ts', added: 3, deleted: 1 }],
    validation: { command: 'pnpm test', exitStatus: 0, outputExcerpt: 'passed' },
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

  await expect(resultPromise).resolves.toMatchObject({
    status: 'cancelled',
    filesChanged: ['source/changed.ts'],
    toolsUsed: [{ toolName: 'write_file', count: 1 }],
    diffStat: [{ path: 'source/changed.ts', added: 3, deleted: 1 }],
    validation: { command: 'pnpm test', exitStatus: 0, outputExcerpt: 'passed' },
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  expect(events).toEqual(['subagent_started', 'subagent_completed']);

  const second = registry.startRun({ role: 'explorer', task: 'second', name: 'reusable' });
  expect(second.name).toBe('reusable');
  registry.dispose();
});

it('lets a continuation claim a free name while preserving its runId and worker policy', async () => {
  const registry = make();
  const first = registry.startRun({ role: 'explorer', task: 'first' });
  await registry.getResult(first.runId);

  const continuation = registry.startRun({
    role: 'explorer',
    task: 'continue',
    continueRunId: first.runId,
    name: 'continued_scan',
  });

  expect(continuation).toMatchObject({ runId: first.runId, name: 'continued_scan' });
  await registry.getResult(continuation.runId);
  registry.dispose();
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

it('cancelAllRuns returns before a late successful runner result settles as cancelled', async () => {
  let resolve!: (value: SubagentResult) => void;
  const registry = make(() => new Promise<SubagentResult>((r) => (resolve = r)));
  const run = registry.startRun({ role: 'explorer', task: 'cancel me' });
  const resultPromise = registry.getResult(run.runId);
  let settled = false;
  void resultPromise.then(() => {
    settled = true;
  });

  registry.cancelAllRuns();
  await Promise.resolve();
  expect(registry.getRunStatus(run.runId)).toMatchObject({ status: 'cancelling' });
  expect(settled).toBe(false);

  resolve(result('explorer'));
  await expect(resultPromise).resolves.toMatchObject({ status: 'cancelled' });
});

it('cancels a run when its parent signal aborts', async () => {
  const controller = new AbortController();
  let resolve!: (value: SubagentResult) => void;
  const registry = make(() => new Promise<SubagentResult>((r) => (resolve = r)));
  const run = registry.startRun({ role: 'explorer', task: 'parent', signal: controller.signal });
  const resultPromise = registry.getResult(run.runId);
  let settled = false;
  void resultPromise.then(() => {
    settled = true;
  });

  controller.abort();
  await Promise.resolve();
  expect(registry.getRunStatus(run.runId)).toMatchObject({ status: 'cancelling' });
  expect(settled).toBe(false);

  resolve({
    ...result('explorer', 'failed'),
    filesChanged: ['partial-research.md'],
    toolsUsed: [{ toolName: 'web_search', count: 2 }],
    diffStat: [{ path: 'partial-research.md', added: 8, deleted: 0 }],
    validation: { command: 'pnpm test', exitStatus: 1, outputExcerpt: 'failed' },
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  });
  await expect(resultPromise).resolves.toMatchObject({
    status: 'cancelled',
    filesChanged: ['partial-research.md'],
    toolsUsed: [{ toolName: 'web_search', count: 2 }],
    diffStat: [{ path: 'partial-research.md', added: 8, deleted: 0 }],
    validation: { command: 'pnpm test', exitStatus: 1, outputExcerpt: 'failed' },
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  });
});

it('runs an already-aborted parent segment so it can settle as cancelled', async () => {
  const parent = new AbortController();
  parent.abort();
  const registry = make(async ({ request, signal }) => {
    expect(signal.aborted).toBe(true);
    return result(request.role);
  });

  const run = registry.startRun({ role: 'explorer', task: 'cancelled before launch', signal: parent.signal });

  await expect(registry.getResult(run.runId)).resolves.toMatchObject({ status: 'cancelled' });
  registry.dispose();
});

it('rejects a fresh run targeting an active shared session', () => {
  const registry = make(() => new Promise<SubagentResult>(() => undefined));
  registry.startRun({ role: 'mentor', task: 'one' });
  expect(() => registry.startRun({ role: 'mentor', task: 'two' })).toThrowError(/already active/);
});

it('returns terminal failures and cancellations instead of rejecting', async () => {
  const failed = make(async ({ request }) => result(request.role, 'failed'));
  const failedRun = failed.startRun({ role: 'explorer', task: 'fail' });
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

it('dispose signals active work, lets obtained result promises settle, and emits no late lifecycle event', async () => {
  let resolve!: (value: SubagentResult) => void;
  const events: string[] = [];
  const registry = new SubagentAsyncRegistry({
    logger: createMockLogger(),
    onEvent: (event) => events.push(event.type),
    setInterval: () => 1 as any,
    clearInterval: () => {},
    run: () => new Promise<SubagentResult>((r) => (resolve = r)),
  });
  const run = registry.startRun({ role: 'explorer', task: 'cancel' });
  const resultPromise = registry.getResult(run.runId);
  registry.dispose();

  expect(events).toEqual(['subagent_started']);
  resolve(result('explorer'));
  await expect(resultPromise).resolves.toMatchObject({ status: 'cancelled' });
  expect(events).toEqual(['subagent_started']);
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

  it('records text turns with the tools that preceded them', () => {
    const registry = make(() => new Promise<SubagentResult>(() => undefined));
    const handle = registry.startRun({ role: 'explorer', task: 'inspect' });

    registry.handleSubagentEvent({
      type: 'subagent_tool_started',
      agentId: handle.runId,
      role: 'explorer',
      toolCallId: 'tc1',
      toolName: 'grep',
      arguments: {},
    });
    registry.handleSubagentEvent({
      type: 'subagent_text_turn',
      agentId: handle.runId,
      role: 'explorer',
      text: 'Looking at config loading...',
    });

    const status = registry.getRunStatus(handle.runId) as any;
    expect(status.turnHistory).toEqual([
      {
        text: 'Looking at config loading...',
        precedingToolCounts: { grep: 1 },
        truncated: false,
      },
    ]);
    expect(status.pendingToolCounts).toBeUndefined();
    registry.dispose();
  });

  it('bounds truncated turn history and returns independent snapshot records', () => {
    const registry = make(() => new Promise<SubagentResult>(() => undefined));
    const handle = registry.startRun({ role: 'explorer', task: 'inspect' });

    for (let index = 1; index <= 6; index++) {
      registry.handleSubagentEvent({
        type: 'subagent_text_turn',
        agentId: handle.runId,
        role: 'explorer',
        text: index === 6 ? '6'.repeat(201) : `turn ${index}`,
      });
    }

    const firstSnapshot = registry.getRunStatus(handle.runId) as any;
    expect(firstSnapshot.turnHistory).toHaveLength(5);
    expect(firstSnapshot.turnHistory[0]).toMatchObject({ text: 'turn 2', truncated: false });
    expect(firstSnapshot.turnHistory[4]).toMatchObject({ text: '6'.repeat(200), truncated: true });

    firstSnapshot.turnHistory[0].text = 'mutated';
    firstSnapshot.turnHistory[0].precedingToolCounts.grep = 99;
    const secondSnapshot = registry.getRunStatus(handle.runId) as any;
    expect(secondSnapshot.turnHistory[0]).toEqual({ text: 'turn 2', precedingToolCounts: {}, truncated: false });
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

describe('outbound steering', () => {
  it('requests cancellation by canonical runId before name and reports only active targets', async () => {
    const resolutions: Array<(value: SubagentResult) => void> = [];
    const registry = new SubagentAsyncRegistry({
      logger: createMockLogger(),
      createRunId: (() => {
        const ids = ['target', 'other'];
        return () => ids.shift()!;
      })(),
      run: () => new Promise<SubagentResult>((resolve) => resolutions.push(resolve)),
    });
    const canonical = registry.startRun({ role: 'explorer', task: 'Canonical.', name: 'canonical' });
    const alias = registry.startRun({ role: 'explorer', task: 'Alias.', name: 'target' });

    expect(registry.cancelRun('target')).toEqual({ ok: true, runId: canonical.runId, status: 'cancelling' });
    expect(registry.getRunStatus(canonical.runId)).toMatchObject({ status: 'cancelling' });
    expect(registry.getRunStatus(alias.runId)).toMatchObject({ status: 'running' });
    expect(registry.cancelRun('missing')).toEqual({ ok: false, code: 'not_active', target: 'missing' });

    resolutions[0](result('explorer', 'cancelled'));
    resolutions[1](result('explorer'));
    await Promise.all([registry.getResult(canonical.runId), registry.getResult(alias.runId)]);
    registry.dispose();
  });

  it('publishes one question and suspends only the asking tool until its matching answer arrives', async () => {
    const segments: RunParams[] = [];
    const events: ConversationEvent[] = [];
    const registry = new SubagentAsyncRegistry({
      logger: createMockLogger(),
      onEvent: (event) => events.push(event),
      run: async (params) => {
        segments.push(params);
        const answer = await params.control.askOrchestrator('Which public API should I use?');
        return { ...result(params.request.role), finalText: answer };
      },
    });
    const run = registry.startRun({ role: 'explorer', task: 'Implement the integration.' });

    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'subagent_question' })));
    const question = events.find((event) => event.type === 'subagent_question');
    expect(question).toMatchObject({
      runId: run.runId,
      role: 'explorer',
      question: 'Which public API should I use?',
    });
    expect((registry.getRunStatus(run.runId) as any).status).toBe('waiting_for_answer');
    expect(segments).toHaveLength(1);

    expect(registry.sendMessage(run.runId, 'Use the public API.', question!.messageId)).toEqual({
      ok: true,
      runId: run.runId,
      status: 'running',
      delivery: 'answered',
    });
    await expect(registry.getResult(run.runId)).resolves.toMatchObject({
      status: 'completed',
      finalText: 'Use the public API.',
    });
    registry.dispose();
  });

  it('rejects mismatched and duplicate replies without changing a waiting run', async () => {
    const events: ConversationEvent[] = [];
    let release!: () => void;
    const afterAnswer = new Promise<void>((resolve) => (release = resolve));
    const registry = new SubagentAsyncRegistry({
      logger: createMockLogger(),
      onEvent: (event) => events.push(event),
      run: async (params) => {
        await params.control.askOrchestrator('Which API?');
        await afterAnswer;
        return result(params.request.role);
      },
    });
    const run = registry.startRun({ role: 'explorer', task: 'Implement.' });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'subagent_question')).toBe(true));
    const pending = events.find((event) => event.type === 'subagent_question')!;

    expect(registry.sendMessage(run.runId, 'Use it.', 'wrong-id')).toEqual({
      ok: false,
      code: 'question_mismatch',
      target: run.runId,
    });
    expect((registry.getRunStatus(run.runId) as any).status).toBe('waiting_for_answer');
    expect(registry.sendMessage(run.runId, 'Use it.', pending.messageId)).toMatchObject({
      ok: true,
      delivery: 'answered',
    });
    expect(registry.sendMessage(run.runId, 'Duplicate.', pending.messageId)).toEqual({
      ok: false,
      code: 'question_not_pending',
      target: run.runId,
    });

    release();
    await expect(registry.getResult(run.runId)).resolves.toMatchObject({ status: 'completed' });
    registry.dispose();
  });

  it('refuses plain steering while a question waits, then queues it once the answer resumes the tool', async () => {
    const segments: RunParams[] = [];
    const events: ConversationEvent[] = [];
    const resolutions: Array<(value: SubagentResult) => void> = [];
    const registry = new SubagentAsyncRegistry({
      logger: createMockLogger(),
      onEvent: (event) => events.push(event),
      run: (params) => {
        segments.push(params);
        if (segments.length === 1) {
          params.control.onToolStart();
          void params.control.askOrchestrator('Which API?').then(() => params.control.onToolComplete());
        }
        return new Promise<SubagentResult>((resolve) => resolutions.push(resolve));
      },
    });
    const run = registry.startRun({ role: 'worker', task: 'Implement.' });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'subagent_question')).toBe(true));
    const pending = events.find((event) => event.type === 'subagent_question')!;

    // Steering that is not an answer can never reach the waiting tool call, so it is
    // refused rather than queued behind a blocker only `reply_to` can clear.
    expect(registry.sendMessage(run.runId, 'Use the public API.')).toEqual({
      ok: false,
      code: 'question_pending',
      target: run.runId,
    });
    expect((registry.getRunStatus(run.runId) as any).status).toBe('waiting_for_answer');

    expect(registry.sendMessage(run.runId, 'Use the supported interface.', pending.messageId)).toMatchObject({
      ok: true,
      delivery: 'answered',
    });
    expect(registry.sendMessage(run.runId, 'Then update the docs.')).toMatchObject({ ok: true, delivery: 'queued' });
    expect(segments[0].signal.aborted).toBe(false);
    await vi.waitFor(() => expect(segments[0].signal.aborted).toBe(true));

    resolutions[0](result('worker', 'cancelled'));
    await vi.waitFor(() => expect(segments).toHaveLength(2));
    expect(segments[1].input).toContain('Then update the docs.');
    resolutions[1](result('worker'));
    await expect(registry.getResult(run.runId)).resolves.toMatchObject({ status: 'completed' });
    registry.dispose();
  });

  it('cancellation rejects the pending answer waiter and wins over a late answer', async () => {
    const events: ConversationEvent[] = [];
    let asked!: Promise<string>;
    const registry = new SubagentAsyncRegistry({
      logger: createMockLogger(),
      onEvent: (event) => events.push(event),
      run: async (params) => {
        asked = params.control.askOrchestrator('Should I continue?');
        try {
          await asked;
          return result(params.request.role);
        } catch (error: any) {
          return { ...result(params.request.role, 'cancelled'), error: error.message };
        }
      },
    });
    const run = registry.startRun({ role: 'explorer', task: 'Inspect.' });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'subagent_question')).toBe(true));
    const pending = events.find((event) => event.type === 'subagent_question')!;

    registry.abortRun(run.runId);
    expect((registry.getRunStatus(run.runId) as any).status).toBe('cancelling');
    await expect(asked).rejects.toThrow('cancelled');
    await expect(registry.getResult(run.runId)).resolves.toMatchObject({ status: 'cancelled' });
    expect(registry.sendMessage(run.runId, 'Too late.', pending.messageId)).toEqual({
      ok: false,
      code: 'not_active',
      target: run.runId,
    });
    registry.dispose();
  });

  it('treats a null reply_to as plain steering rather than an answer to a question', () => {
    const registry = new SubagentAsyncRegistry({
      logger: createMockLogger(),
      run: () => new Promise<SubagentResult>(() => {}),
    });
    const run = registry.startRun({ role: 'explorer', task: 'Inspect the repository.', name: 'scan' });

    expect(registry.sendMessage('scan', 'Focus on the command parser.', null)).toEqual({
      ok: true,
      runId: run.runId,
      status: 'running',
      delivery: 'queued',
    });
    registry.dispose();
  });

  it('restarts an interrupted execution run in the same session with a fresh guided user turn', async () => {
    const segments: RunParams[] = [];
    const resolutions: Array<(value: SubagentResult) => void> = [];
    const registry = new SubagentAsyncRegistry({
      logger: createMockLogger(),
      run: (params) => {
        segments.push(params);
        return new Promise<SubagentResult>((resolve) => resolutions.push(resolve));
      },
    });
    const run = registry.startRun({ role: 'explorer', task: 'Inspect the repository.', name: 'scan' });

    expect(registry.sendMessage('scan', 'Focus on the command parser.')).toEqual({
      ok: true,
      runId: run.runId,
      status: 'running',
      delivery: 'queued',
    });
    expect(segments[0].signal.aborted).toBe(true);

    resolutions[0]({
      ...result('explorer', 'cancelled'),
      filesChanged: ['source/partial.ts'],
      toolsUsed: [{ toolName: 'read_file', count: 1 }],
    });
    await vi.waitFor(() => expect(segments).toHaveLength(2));

    expect(segments[1]).toMatchObject({
      runId: run.runId,
      session: segments[0].session,
      input: expect.stringContaining('Focus on the command parser.'),
    });
    expect(segments[1].input).toContain('prior segment was interrupted');
    expect(segments[1].input).toContain('inspect and reconcile current work');
    expect(segments[1].input).not.toBe(segments[0].input);

    resolutions[1](result('explorer'));
    await expect(registry.getResult(run.runId)).resolves.toMatchObject({
      status: 'completed',
      filesChanged: ['source/partial.ts'],
      toolsUsed: [{ toolName: 'read_file', count: 1 }],
    });
    registry.dispose();
  });

  it('waits for every active tool before aborting a segment and coalesces all guidance into one continuation', async () => {
    const segments: RunParams[] = [];
    const resolutions: Array<(value: SubagentResult) => void> = [];
    const registry = new SubagentAsyncRegistry({
      logger: createMockLogger(),
      run: (params) => {
        segments.push(params);
        return new Promise<SubagentResult>((resolve) => resolutions.push(resolve));
      },
    });
    const run = registry.startRun({ role: 'worker', task: 'Make the change.' });

    segments[0].control.onToolStart();
    segments[0].control.onToolStart();
    expect(registry.sendMessage(run.runId, 'Use the public API.')).toMatchObject({ ok: true });
    expect(registry.sendMessage(run.runId, 'Add a regression test.')).toMatchObject({ ok: true });
    expect(segments[0].signal.aborted).toBe(false);

    segments[0].control.onToolComplete();
    expect(segments[0].signal.aborted).toBe(false);
    segments[0].control.onToolComplete();
    expect(segments[0].signal.aborted).toBe(true);

    resolutions[0](result('worker', 'cancelled'));
    await vi.waitFor(() => expect(segments).toHaveLength(2));
    expect(segments[1].input).toContain('Use the public API.\nAdd a regression test.');

    resolutions[1](result('worker'));
    await expect(registry.getResult(run.runId)).resolves.toMatchObject({ status: 'completed' });
    registry.dispose();
  });

  it('rejects steering after three continuation segments without interrupting the productive segment', async () => {
    const segments: RunParams[] = [];
    const resolutions: Array<(value: SubagentResult) => void> = [];
    const registry = new SubagentAsyncRegistry({
      logger: createMockLogger(),
      run: (params) => {
        segments.push(params);
        return new Promise<SubagentResult>((resolve) => resolutions.push(resolve));
      },
    });
    const run = registry.startRun({ role: 'explorer', task: 'Research this.' });

    for (let segment = 0; segment < 3; segment++) {
      expect(registry.sendMessage(run.runId, `Revision ${segment + 1}`)).toMatchObject({ ok: true });
      resolutions[segment](result('explorer', 'cancelled'));
      await vi.waitFor(() => expect(segments).toHaveLength(segment + 2));
    }

    expect(registry.sendMessage(run.runId, 'A fourth revision.')).toEqual({
      ok: false,
      code: 'steer_limit_reached',
      target: run.runId,
    });
    expect(segments[3].signal.aborted).toBe(false);

    resolutions[3](result('explorer'));
    await expect(registry.getResult(run.runId)).resolves.toMatchObject({ status: 'completed' });
    registry.dispose();
  });

  it('returns typed errors for invalid, inactive, and mentor steering targets', async () => {
    const registry = make(() => new Promise<SubagentResult>(() => undefined));
    const execution = registry.startRun({ role: 'explorer', task: 'Inspect.', name: 'scan' });
    const mentor = registry.startRun({ role: 'mentor', task: 'Advise.', name: 'advice' });

    expect(registry.sendMessage('scan', '   ')).toEqual({ ok: false, code: 'invalid_guidance', target: 'scan' });
    expect(registry.sendMessage('missing', 'Inspect this.')).toEqual({
      ok: false,
      code: 'not_active',
      target: 'missing',
    });
    expect(registry.sendMessage('advice', 'Change direction.')).toEqual({
      ok: false,
      code: 'unsupported_control',
      target: 'advice',
    });
    expect(registry.sendMessage(execution.runId, 'x'.repeat(2001))).toEqual({
      ok: false,
      code: 'invalid_guidance',
      target: execution.runId,
    });
    registry.dispose();
  });

  it('resolves an active canonical run id before an active name with the same target text', () => {
    const segments: RunParams[] = [];
    const registry = new SubagentAsyncRegistry({
      logger: createMockLogger(),
      createRunId: (() => {
        const ids = ['target', 'other'];
        return () => ids.shift()!;
      })(),
      run: (params) => {
        segments.push(params);
        return new Promise<SubagentResult>(() => undefined);
      },
    });
    const canonical = registry.startRun({ role: 'explorer', task: 'Canonical.', name: 'canonical' });
    const alias = registry.startRun({ role: 'explorer', task: 'Alias.', name: 'target' });

    expect(registry.sendMessage('target', 'Steer the canonical run.')).toMatchObject({
      ok: true,
      runId: canonical.runId,
    });
    expect(segments.find((segment) => segment.runId === canonical.runId)?.signal.aborted).toBe(true);
    expect(segments.find((segment) => segment.runId === alias.runId)?.signal.aborted).toBe(false);
    registry.dispose();
  });

  it('lets cancellation win over queued steering without concurrent segments or duplicate completion', async () => {
    const segments: RunParams[] = [];
    const resolutions: Array<(value: SubagentResult) => void> = [];
    const events: string[] = [];
    const registry = new SubagentAsyncRegistry({
      logger: createMockLogger(),
      onEvent: (event) => events.push(event.type),
      run: (params) => {
        segments.push(params);
        return new Promise<SubagentResult>((resolve) => resolutions.push(resolve));
      },
    });
    const run = registry.startRun({ role: 'explorer', task: 'Inspect.' });

    expect(registry.sendMessage(run.runId, 'Restart with this guidance.')).toMatchObject({ ok: true });
    registry.abortRun(run.runId);
    resolutions[0](result('explorer'));
    await expect(registry.getResult(run.runId)).resolves.toMatchObject({ status: 'cancelled' });

    expect(segments).toHaveLength(1);
    expect(events).toEqual(['subagent_started', 'subagent_completed']);
    expect(registry.sendMessage(run.runId, 'Too late.')).toEqual({
      ok: false,
      code: 'not_active',
      target: run.runId,
    });
    registry.dispose();
  });

  it('wires completed execution tools to release steering and sends the continuation as a fresh session turn', async () => {
    const inputs: unknown[] = [];
    let firstSignal: AbortSignal | undefined;
    let firstToolCompleted!: () => void;
    const toolCompleted = new Promise<void>((resolve) => (firstToolCompleted = resolve));
    const providerId = registerTestProvider({
      label: 'Steering execution runner provider',
      createStreamedModel: () =>
        ({
          stream: async function* (request: any) {
            inputs.push(request.input);
            if (inputs.length === 1) {
              const readFile = request.applicationTools?.find((tool: any) => tool.name === 'read_file');
              await readFile?.execute(JSON.stringify({ path: 'package.json' }), {}, {});
              firstToolCompleted();
              firstSignal = request.signal;
              await new Promise((_resolve, reject) => {
                request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
              });
              return;
            }
            yield* wrapResultAsAgentStream({ status: 'completed', finalOutput: 'done', history: [], messages: [] });
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });
    const settings = createMockSettings({ 'agent.model': 'mock-model', 'agent.provider': providerId });
    const logger = createMockLogger();
    const sessionContextService = createSessionContextService();
    const toolOwnership = new ToolOwnershipRegistry();
    const runtime = createSubagentRuntime({
      logger,
      settings,
      sessionContextService,
      toolOwnership,
      createClient: ({ agent, provider, maxTurns, retryAttempts }) =>
        new AgentClient({
          model: agent.model,
          maxTurns,
          retryAttempts,
          deps: { logger, settings, sessionContextService },
          agentOverride: agent,
          providerOverride: provider,
          toolOwnership,
        }),
    });
    const run = runtime.asyncRegistry.startRun({ role: 'explorer', task: 'Inspect package metadata.' });

    await toolCompleted;
    expect(runtime.asyncRegistry.sendMessage(run.runId, 'Now inspect scripts.')).toMatchObject({ ok: true });
    expect(firstSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(inputs).toHaveLength(2));

    expect(inputs[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining('Now inspect scripts.') }),
          ]),
        }),
      ]),
    );
    expect(JSON.stringify(inputs[1])).toContain('prior segment was interrupted');
    await expect(runtime.asyncRegistry.getResult(run.runId)).resolves.toMatchObject({ status: 'completed' });
    runtime.asyncRegistry.dispose();
  });
});

describe('default run id allocation', () => {
  it('allocates a codename runId by default instead of a UUID', () => {
    const registry = make(() => new Promise<SubagentResult>(() => undefined));
    const handle = registry.startRun({ role: 'explorer', task: 'inspect' });
    expect(handle.runId).toMatch(CODENAME_RUN_ID_PATTERN);
    expect(handle.runId).not.toMatch(/[0-9a-f]{8}-/);
    registry.dispose();
  });

  it('defends against a factory collision by retrying distinct ids', () => {
    // A factory that always collides on the first call forces the allocator to
    // retry; the second call yields a distinct id the registry can accept.
    let calls = 0;
    const registry = new SubagentAsyncRegistry({
      logger: createMockLogger(),
      createRunId: () => {
        calls += 1;
        // First two draws collide against a run seeded below; third is fresh.
        return calls <= 2 ? 'nascent-finch-10' : 'calm-otter-42';
      },
      run: () => new Promise<SubagentResult>(() => undefined),
    });
    // Seed the collision target as an active run under the colliding id.
    const first = registry.startRun({ role: 'explorer', task: 'seed' });
    expect(first.runId).toBe('nascent-finch-10');
    // The next allocation must avoid the in-use id.
    const second = registry.startRun({ role: 'explorer', task: 'next' });
    expect(second.runId).toBe('calm-otter-42');
    registry.dispose();
  });
});
