import { expect, it } from 'vitest';
import { BACKGROUND_TASK_RECENT_RETENTION_MS, SubagentNotificationStore } from './subagent-notification-store.js';
import { SubagentAsyncRegistry } from './subagent-async-registry.js';
import { createMockLogger } from './test-helpers/subagent-manager-fixtures.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { SubagentResult } from './types.js';

const result = (overrides: Partial<SubagentResult> = {}): SubagentResult => ({
  agentId: 'run-1',
  role: 'explorer',
  status: 'completed',
  finalText: 'found the bug',
  filesChanged: [],
  toolsUsed: [],
  ...overrides,
});

const completed = (overrides: Partial<SubagentResult> = {}): ConversationEvent =>
  ({ type: 'subagent_completed', result: result(overrides), async: true } as ConversationEvent);

const question = (
  overrides: Partial<Extract<ConversationEvent, { type: 'subagent_question' }>> = {},
): ConversationEvent =>
  ({
    type: 'subagent_question',
    async: true,
    messageId: 'question-1',
    runId: 'run-1',
    role: 'explorer',
    question: 'Which API should I use?',
    ...overrides,
  } as ConversationEvent);

const started = (
  overrides: Partial<Extract<ConversationEvent, { type: 'subagent_started' }>> = {},
): ConversationEvent =>
  ({
    type: 'subagent_started',
    agentId: 'run-1',
    role: 'explorer',
    task: 'inspect the project',
    parentTool: 'run_subagent_async',
    async: true,
    ...overrides,
  } as ConversationEvent);

const toolStarted = (
  overrides: Partial<Extract<ConversationEvent, { type: 'subagent_tool_started' }>> = {},
): ConversationEvent =>
  ({
    type: 'subagent_tool_started',
    agentId: 'run-1',
    role: 'explorer',
    toolCallId: 'tool-1',
    toolName: 'grep',
    arguments: { pattern: 'TODO', path: 'src/' },
    ...overrides,
  } as ConversationEvent);

const toolFinished = (
  message: Record<string, unknown> = {},
  overrides: Partial<Extract<ConversationEvent, { type: 'subagent_command_message' }>> = {},
): ConversationEvent =>
  ({
    type: 'subagent_command_message',
    agentId: 'run-1',
    role: 'explorer',
    message: {
      id: 'cmd-1',
      sender: 'command',
      status: 'completed',
      command: 'grep "TODO" src/',
      success: true,
      toolName: 'grep',
      ...message,
    },
    ...overrides,
  } as ConversationEvent);

const shellStarted = (
  overrides: Partial<Extract<ConversationEvent, { type: 'background_shell_started' }>> = {},
): ConversationEvent =>
  ({
    type: 'background_shell_started',
    jobId: 'shell-1',
    command: 'pnpm test',
    ...overrides,
  } as ConversationEvent);

const shellCompleted = (
  overrides: Partial<Extract<ConversationEvent, { type: 'background_shell_completed' }>> = {},
): ConversationEvent =>
  ({
    type: 'background_shell_completed',
    jobId: 'shell-1',
    command: 'pnpm test',
    status: 'completed',
    output: 'exit 0\nall tests passed',
    ...overrides,
  } as ConversationEvent);

const shellOutput = (
  overrides: Partial<Extract<ConversationEvent, { type: 'background_shell_output' }>> = {},
): ConversationEvent =>
  ({
    type: 'background_shell_output',
    jobId: 'shell-1',
    command: 'pnpm test',
    watchId: 'watch-1',
    seq: 1,
    matchedLines: 'Listening on http://localhost:3000',
    ...overrides,
  } as ConversationEvent);

const budget = (event: Extract<ConversationEvent, { type: 'subagent_run_budget' }>['event']): ConversationEvent =>
  ({ type: 'subagent_run_budget', agentId: 'run-1', role: 'explorer', event } as ConversationEvent);

const checkInDue = (
  overrides: Partial<Extract<ConversationEvent, { type: 'background_check_in_due' }>> = {},
): ConversationEvent =>
  ({
    type: 'background_check_in_due',
    target: { kind: 'shell', id: 'shell-1' },
    checkInIndex: 1,
    elapsedMs: 300_000,
    details: { kind: 'shell', id: 'shell-1', command: 'pnpm test' },
    ...overrides,
  } as ConversationEvent);

const makeStore = (options: { now?: () => number; deliveredIdCap?: number } = {}) =>
  new SubagentNotificationStore({ now: () => 1_000, ...options });

const firstSubagentTask = (store: SubagentNotificationStore) => {
  const task = store.getTaskSnapshot()[0];
  if (!task || task.kind === 'shell') throw new Error('Expected a subagent task.');
  return task;
};

it('records one notification carrying the run identity, status and preview', () => {
  const store = makeStore({ now: () => 4_242 });

  expect(store.enqueue(completed())).toBe(true);

  expect(store.drain()).toEqual([
    {
      kind: 'completion',
      messageId: 'completion:run-1',
      runId: 'run-1',
      role: 'explorer',
      status: 'completed',
      preview: 'found the bug',
      formattedResult: expect.stringMatching(/^Status: completed/),
      completedAt: 4_242,
    },
  ]);
});

it('queues structured budget and stall evidence through the same exact-once notification lane', () => {
  const store = makeStore({ now: () => 4_242 });

  expect(
    store.enqueue(
      budget({
        type: 'budget_stage',
        stage: 'warning',
        evidence: { dimension: 'turns', used: 101, limit: 100, headroom: -1 },
      }),
    ),
  ).toBe(true);
  expect(
    store.enqueue(
      budget({
        type: 'budget_stage',
        stage: 'warning',
        evidence: { dimension: 'turns', used: 101, limit: 100, headroom: -1 },
      }),
    ),
  ).toBe(false);

  expect(store.drain()).toEqual([
    expect.objectContaining({
      kind: 'budget',
      messageId: 'budget:run-1:budget_stage:warning:turns',
      runId: 'run-1',
      role: 'explorer',
      recordedAt: 4_242,
    }),
  ]);
});

it('does not escalate a soft stage, which the child receives in its own tool output', () => {
  const store = makeStore({ now: () => 4_242 });

  expect(
    store.enqueue(
      budget({
        type: 'budget_stage',
        stage: 'soft',
        evidence: { dimension: 'usd', used: 90, limit: 100, headroom: 10 },
      }),
    ),
  ).toBe(false);
  expect(
    store.enqueue(
      budget({
        type: 'tool_stall',
        toolName: 'shell',
        argumentsText: '{"command":"ls"}',
        count: 3,
        threshold: 3,
      }),
    ),
  ).toBe(true);

  expect(store.drain()).toEqual([expect.objectContaining({ kind: 'budget', runId: 'run-1' })]);
});

it('projects a shell job and enqueues its bounded completion independently of subagent runs', () => {
  const store = makeStore({ now: () => 4_242 });

  expect(store.recordLifecycle(shellStarted())).toBe(true);
  expect(store.getTaskSnapshot()).toEqual([
    {
      kind: 'shell',
      jobId: 'shell-1',
      command: 'pnpm test',
      status: 'running',
      startedAt: 4_242,
    },
  ]);

  expect(store.recordLifecycle(shellCompleted({ status: 'failed', error: 'tests failed' }))).toBe(true);
  expect(store.enqueue(shellCompleted({ status: 'failed', error: 'tests failed' }))).toBe(true);
  expect(store.drain()).toEqual([
    {
      kind: 'shell_completion',
      messageId: 'shell_completion:shell-1',
      jobId: 'shell-1',
      command: 'pnpm test',
      status: 'failed',
      output: 'exit 0\nall tests passed',
      error: 'tests failed',
      completedAt: 4_242,
    },
  ]);
  expect(store.getTaskSnapshot()).toEqual([
    expect.objectContaining({ kind: 'shell', jobId: 'shell-1', status: 'failed', completedAt: 4_242 }),
  ]);
});

it('keeps mixed questions and completions in message order and dedupes each by message id', () => {
  const store = makeStore();

  expect(store.enqueue(question())).toBe(true);
  expect(store.enqueue(completed())).toBe(true);
  expect(store.enqueue(question())).toBe(false);
  expect(store.enqueue(question({ messageId: 'question-2', question: 'Should I update the call site?' }))).toBe(true);

  expect(store.drain()).toEqual([
    expect.objectContaining({ kind: 'question', messageId: 'question-1', runId: 'run-1' }),
    expect.objectContaining({ kind: 'completion', messageId: 'completion:run-1', runId: 'run-1' }),
    expect.objectContaining({ kind: 'question', messageId: 'question-2', runId: 'run-1' }),
  ]);
});

it('retains a question ahead of newer completions using its message id', () => {
  const store = makeStore();
  store.enqueue(question());
  const undelivered = store.drain();
  store.enqueue(completed({ agentId: 'run-2' }));
  store.retain(undelivered);

  expect(store.drain().map((notification) => notification.messageId)).toEqual(['question-1', 'completion:run-2']);
});

it('drains watch firings before the job completion and never after it', () => {
  const store = makeStore({ now: () => 4_242 });

  expect(store.enqueue(shellOutput())).toBe(true);
  expect(store.enqueue(shellOutput({ seq: 2, matchedLines: 'error TS2345', droppedBytes: 512 }))).toBe(true);
  expect(store.enqueue(shellCompleted())).toBe(true);

  expect(store.drain()).toEqual([
    {
      kind: 'shell_output',
      messageId: 'shell_output:shell-1:watch-1:1',
      jobId: 'shell-1',
      command: 'pnpm test',
      watchId: 'watch-1',
      seq: 1,
      matchedLines: 'Listening on http://localhost:3000',
      recordedAt: 4_242,
    },
    {
      kind: 'shell_output',
      messageId: 'shell_output:shell-1:watch-1:2',
      jobId: 'shell-1',
      command: 'pnpm test',
      watchId: 'watch-1',
      seq: 2,
      matchedLines: 'error TS2345',
      droppedBytes: 512,
      recordedAt: 4_242,
    },
    expect.objectContaining({ kind: 'shell_completion', messageId: 'shell_completion:shell-1' }),
  ]);
});

it('retains watch firings ahead of newer notifications in message order', () => {
  const store = makeStore();
  store.enqueue(shellOutput());
  const undelivered = store.drain();
  store.enqueue(shellCompleted());
  store.retain(undelivered);

  expect(store.drain().map((notification) => notification.messageId)).toEqual([
    'shell_output:shell-1:watch-1:1',
    'shell_completion:shell-1',
  ]);
});

it('keeps every distinct watch firing and drops an exact messageId duplicate once', () => {
  const store = makeStore();

  expect(store.enqueue(shellOutput())).toBe(true);
  // Same watch, next firing: distinct messageId, must not be deduped.
  expect(store.enqueue(shellOutput({ seq: 2, matchedLines: 'second firing' }))).toBe(true);
  // Exact replay of the first firing: deduped.
  expect(store.enqueue(shellOutput())).toBe(false);
  // A different watch reusing seq 1: distinct messageId.
  expect(store.enqueue(shellOutput({ watchId: 'watch-2' }))).toBe(true);

  expect(store.drain().map((notification) => notification.messageId)).toEqual([
    'shell_output:shell-1:watch-1:1',
    'shell_output:shell-1:watch-1:2',
    'shell_output:shell-1:watch-2:1',
  ]);
});

it('does not project a watch firing into the task lifecycle', () => {
  const store = makeStore();
  store.recordLifecycle(shellStarted());

  expect(store.recordLifecycle(shellOutput())).toBe(false);
  expect(store.getTaskSnapshot()).toEqual([
    expect.objectContaining({ kind: 'shell', jobId: 'shell-1', status: 'running' }),
  ]);
});

it('records a check-in notification carrying task identity and elapsed time', () => {
  const store = makeStore({ now: () => 4_242 });

  expect(store.enqueue(checkInDue())).toBe(true);
  expect(store.drain()).toEqual([
    {
      kind: 'check_in',
      messageId: 'check_in:shell:shell-1:1',
      target: { kind: 'shell', id: 'shell-1' },
      checkInIndex: 1,
      elapsedMs: 300_000,
      details: { kind: 'shell', id: 'shell-1', command: 'pnpm test' },
      recordedAt: 4_242,
    },
  ]);
});

it('keeps repeat check-ins on the same task distinct and drops an exact replay once', () => {
  const store = makeStore();

  expect(store.enqueue(checkInDue())).toBe(true);
  expect(store.enqueue(checkInDue({ checkInIndex: 2, elapsedMs: 600_000 }))).toBe(true);
  expect(store.enqueue(checkInDue())).toBe(false);

  expect(store.drain().map((notification) => notification.messageId)).toEqual([
    'check_in:shell:shell-1:1',
    'check_in:shell:shell-1:2',
  ]);
});

it('does not project a check-in into the task lifecycle', () => {
  const store = makeStore();
  store.recordLifecycle(shellStarted());

  expect(store.recordLifecycle(checkInDue())).toBe(false);
  expect(store.getTaskSnapshot()).toEqual([
    expect.objectContaining({ kind: 'shell', jobId: 'shell-1', status: 'running' }),
  ]);
});

it('projects an async start as a running background task with role, task, and start time', () => {
  const store = makeStore({ now: () => 4_242 });

  expect(store.recordLifecycle(started({ name: 'code_scan' }))).toBe(true);
  expect(store.getTaskSnapshot()).toEqual([
    {
      kind: 'subagent',
      runId: 'run-1',
      name: 'code_scan',
      role: 'explorer',
      task: 'inspect the project',
      status: 'running',
      startedAt: 4_242,
    },
  ]);
});

it('retains a subagent name and context usage when a task completes', () => {
  const store = makeStore();
  store.recordLifecycle(started({ name: 'code_scan' }));
  store.recordLifecycle(completed({ usage: { prompt_tokens: 12_345 } }));

  expect(store.getTaskSnapshot()).toEqual([
    expect.objectContaining({ name: 'code_scan', usage: { prompt_tokens: 12_345 }, status: 'completed' }),
  ]);
});

it('updates the live background task projection from a usage event', () => {
  const store = makeStore();
  store.recordLifecycle(started());

  const changed = store.recordLifecycle({
    type: 'usage_update',
    agentId: 'run-1',
    usage: { prompt_tokens: 240, completion_tokens: 60, total_tokens: 300 },
  } as ConversationEvent);

  expect(changed).toBe(true);
  expect(store.getTaskSnapshot()).toEqual([
    expect.objectContaining({
      runId: 'run-1',
      status: 'running',
      usage: { prompt_tokens: 240, completion_tokens: 60, total_tokens: 300 },
    }),
  ]);
});

it('ignores foreground subagent lifecycle in the background task projection', () => {
  const store = makeStore();

  expect(store.recordLifecycle(started({ async: false }))).toBe(false);
  expect(store.recordLifecycle({ ...started(), async: undefined } as ConversationEvent)).toBe(false);
  expect(
    store.recordLifecycle({ ...completed({ agentId: 'foreground-run' }), async: false } as ConversationEvent),
  ).toBe(false);

  expect(store.getTaskSnapshot()).toEqual([]);
});

it('retains a completed task briefly and expires it while active tasks remain', () => {
  let now = 1_000;
  const store = makeStore({ now: () => now });
  store.recordLifecycle(started());

  now = 4_000;
  store.recordLifecycle(completed());
  expect(store.getTaskSnapshot()).toEqual([
    expect.objectContaining({
      status: 'completed',
      startedAt: 1_000,
      completedAt: 4_000,
    }),
  ]);

  now = 4_000 + BACKGROUND_TASK_RECENT_RETENTION_MS - 1;
  expect(store.getTaskSnapshot()).toHaveLength(1);

  now = 4_000 + BACKGROUND_TASK_RECENT_RETENTION_MS;
  expect(store.getTaskSnapshot()).toEqual([]);
  expect(store.recordLifecycle(completed())).toBe(false);
  expect(store.getTaskSnapshot()).toEqual([]);

  store.recordLifecycle(started({ agentId: 'run-active', role: 'worker', task: 'make the change' }));
  now += BACKGROUND_TASK_RECENT_RETENTION_MS * 2;
  expect(store.getTaskSnapshot()).toEqual([
    expect.objectContaining({
      runId: 'run-active',
      role: 'worker',
      status: 'running',
    }),
  ]);
});

it('projects a continuation of a settled run as a live task again', () => {
  let now = 1_000;
  const store = makeStore({ now: () => now });
  store.recordLifecycle(started());
  store.recordLifecycle(completed());

  now += BACKGROUND_TASK_RECENT_RETENTION_MS;
  expect(store.getTaskSnapshot()).toEqual([]);

  // `continue_run_id` reuses the run id, so the second start carries the id of a
  // run the store already saw settle.
  expect(store.recordLifecycle(started({ task: 'continue the assessment' }))).toBe(true);
  expect(store.getTaskSnapshot()).toEqual([
    {
      kind: 'subagent',
      runId: 'run-1',
      role: 'explorer',
      task: 'continue the assessment',
      status: 'running',
      startedAt: now,
    },
  ]);
});

it('notifies the main agent again when a continued run completes', () => {
  let now = 1_000;
  const store = makeStore({ now: () => now });
  store.recordLifecycle(started());
  store.recordLifecycle(completed());
  expect(store.enqueue(completed())).toBe(true);
  store.drain();

  now += BACKGROUND_TASK_RECENT_RETENTION_MS;
  store.recordLifecycle(started({ task: 'continue the assessment' }));
  store.recordLifecycle(completed());

  expect(store.enqueue(completed())).toBe(true);
  expect(store.drain()).toEqual([expect.objectContaining({ kind: 'completion', runId: 'run-1', status: 'completed' })]);
});

it('notifies the main agent again when the user stops a continued lifecycle with the same run id', () => {
  let now = 1_000;
  const store = makeStore({ now: () => now });
  const stop = {
    action: 'stop' as const,
    target: { kind: 'subagent' as const, id: 'run-1' },
    details: { kind: 'subagent' as const, id: 'run-1', role: 'explorer', task: 'inspect' },
  };

  store.recordLifecycle(started());
  expect(store.enqueueUserControl(stop)).toBe(true);
  expect(store.enqueueUserControl(stop)).toBe(false);
  store.drain();
  store.recordLifecycle(completed());

  now += BACKGROUND_TASK_RECENT_RETENTION_MS;
  store.getTaskSnapshot();
  store.recordLifecycle(started({ task: 'continue the assessment' }));

  expect(store.enqueueUserControl(stop)).toBe(true);
  expect(store.drain()).toEqual([expect.objectContaining({ messageId: 'user_control:stop:subagent:run-1:2' })]);
});

it('still drops a replayed completion of a run that was never continued', () => {
  let now = 1_000;
  const store = makeStore({ now: () => now });
  store.recordLifecycle(started());
  store.recordLifecycle(completed());
  store.enqueue(completed());
  store.drain();

  now += BACKGROUND_TASK_RECENT_RETENTION_MS;

  expect(store.enqueue(completed())).toBe(false);
  expect(store.drain()).toEqual([]);
});

it('reports only lifecycle events that change the visible task projection', () => {
  const store = makeStore();

  expect(store.recordLifecycle(started())).toBe(true);
  expect(store.recordLifecycle(started())).toBe(false);
  expect(store.recordLifecycle(toolStarted())).toBe(true);
  expect(store.recordLifecycle(toolStarted())).toBe(false);
  expect(store.recordLifecycle(completed())).toBe(true);
  expect(store.recordLifecycle(started())).toBe(false);
  expect(store.getTaskSnapshot()[0]?.status).toBe('completed');
});

it('projects the running tool a live background run just started', () => {
  const store = makeStore();
  store.recordLifecycle(started());

  expect(store.recordLifecycle(toolStarted())).toBe(true);
  expect(firstSubagentTask(store).lastTool).toEqual({
    label: 'grep "TODO" src/',
    state: 'running',
  });
});

it('parses JSON-string tool arguments into the projected tool label', () => {
  const store = makeStore();
  store.recordLifecycle(started());

  store.recordLifecycle(toolStarted({ toolName: 'shell', arguments: '{"command":"pnpm test"}' }));

  expect(firstSubagentTask(store).lastTool).toEqual({
    label: 'pnpm test',
    state: 'running',
  });
});

it('settles the projected tool to its outcome when the background tool call finishes', () => {
  const store = makeStore();
  store.recordLifecycle(started());
  store.recordLifecycle(toolStarted());

  expect(store.recordLifecycle(toolFinished())).toBe(true);
  expect(firstSubagentTask(store).lastTool).toEqual({
    label: 'grep "TODO" src/',
    state: 'success',
  });

  expect(store.recordLifecycle(toolFinished({ command: 'pnpm test', success: false, toolName: 'shell' }))).toBe(true);
  expect(firstSubagentTask(store).lastTool).toEqual({
    label: 'pnpm test',
    state: 'failed',
  });
});

it('replaces the projected tool so only the most recent background tool call is visible', () => {
  const store = makeStore();
  store.recordLifecycle(started());
  store.recordLifecycle(toolStarted());
  store.recordLifecycle(toolFinished());

  store.recordLifecycle(toolStarted({ toolCallId: 'tool-2', toolName: 'shell', arguments: { command: 'pnpm build' } }));

  expect(firstSubagentTask(store).lastTool).toEqual({
    label: 'pnpm build',
    state: 'running',
  });
});

it('ignores tool activity for runs that are unknown or already settled', () => {
  const store = makeStore();
  store.recordLifecycle(started());
  store.recordLifecycle(completed());

  expect(store.recordLifecycle(toolStarted())).toBe(false);
  expect(store.recordLifecycle(toolStarted({ agentId: 'foreground-run' }))).toBe(false);
  expect(firstSubagentTask(store).lastTool).toBeUndefined();
});

it('ignores tool activity that carries no displayable command', () => {
  const store = makeStore();
  store.recordLifecycle(started());

  expect(store.recordLifecycle(toolFinished({ command: undefined }))).toBe(false);
  expect(firstSubagentTask(store).lastTool).toBeUndefined();
});

it('ignores completion events that are not async runs', () => {
  const store = makeStore();

  expect(store.enqueue({ type: 'subagent_completed', result: result() } as ConversationEvent)).toBe(false);
  expect(store.enqueue({ type: 'subagent_completed', result: result(), async: false } as ConversationEvent)).toBe(
    false,
  );
  expect(store.enqueue({ type: 'subagent_started', agentId: 'run-1', role: 'explorer' } as ConversationEvent)).toBe(
    false,
  );

  expect(store.pendingCount).toBe(0);
  expect(store.drain()).toEqual([]);
});

it('reports a repeated run id as not novel and keeps a single notification', () => {
  const store = makeStore();

  expect(store.enqueue(completed())).toBe(true);
  expect(store.enqueue(completed())).toBe(false);

  expect(store.drain()).toHaveLength(1);
});

it('keeps a run id deduped after it has been drained', () => {
  const store = makeStore();
  store.enqueue(completed());
  store.drain();

  expect(store.enqueue(completed())).toBe(false);
  expect(store.drain()).toEqual([]);
});

it('carries the failure status and error text of a failed run', () => {
  const store = makeStore();
  store.enqueue(completed({ agentId: 'run-fail', status: 'failed', finalText: '', error: 'model exploded' }));

  expect(store.drain()).toEqual([
    {
      kind: 'completion',
      messageId: 'completion:run-fail',
      runId: 'run-fail',
      role: 'explorer',
      status: 'failed',
      preview: 'model exploded',
      formattedResult: expect.stringMatching(/^Status: failed/),
      error: 'model exploded',
      completedAt: 1_000,
    },
  ]);
});

it('carries the cancellation status and error text of a cancelled run', () => {
  const store = makeStore();
  store.enqueue(
    completed({ agentId: 'run-cancel', status: 'cancelled', finalText: '', error: 'The subagent run was aborted.' }),
  );

  expect(store.drain()).toEqual([
    {
      kind: 'completion',
      messageId: 'completion:run-cancel',
      runId: 'run-cancel',
      role: 'explorer',
      status: 'cancelled',
      preview: 'The subagent run was aborted.',
      formattedResult: expect.stringMatching(/^Status: cancelled/),
      error: 'The subagent run was aborted.',
      completedAt: 1_000,
    },
  ]);
});

it('drains every pending run in one call in completion order', () => {
  const store = makeStore();
  store.enqueue(completed({ agentId: 'run-a' }));
  store.enqueue(completed({ agentId: 'run-b', role: 'explorer' }));

  expect(store.pendingCount).toBe(2);
  const drained = store.drain();

  expect(drained.filter((n) => n.kind === 'completion').map((n) => n.runId)).toEqual(['run-a', 'run-b']);
  expect(store.pendingCount).toBe(0);
});

it('retains undelivered notifications ahead of newer ones for the next drain', () => {
  const store = makeStore();
  store.enqueue(completed({ agentId: 'run-a' }));
  const undelivered = store.drain();

  store.enqueue(completed({ agentId: 'run-b' }));
  store.retain(undelivered);

  expect(
    store
      .drain()
      .filter((n) => n.kind === 'completion')
      .map((n) => n.runId),
  ).toEqual(['run-a', 'run-b']);
  expect(store.drain()).toEqual([]);
});

it('bounds the delivered id set so old ids are forgotten before recent ones', () => {
  const store = makeStore({ deliveredIdCap: 3 });
  for (const agentId of ['run-0', 'run-1', 'run-2', 'run-3']) {
    store.enqueue(completed({ agentId }));
  }
  store.drain();

  // The oldest id has been evicted from the bounded set; the newest are still deduped.
  expect(store.enqueue(completed({ agentId: 'run-0' }))).toBe(true);
  expect(store.enqueue(completed({ agentId: 'run-3' }))).toBe(false);
});

it('truncates a long preview to a bounded single paragraph', () => {
  const store = makeStore();
  store.enqueue(completed({ finalText: `${'x'.repeat(400)}\n\nsecond paragraph` }));

  const [notification] = store.drain();
  expect(notification.kind).toBe('completion');
  if (notification.kind !== 'completion') throw new Error('Expected a completion notification.');
  expect(notification.preview).toHaveLength(300);
  expect(notification.preview.endsWith('...')).toBe(true);
});

it('ignores completion events without a run id', () => {
  const store = makeStore();

  expect(store.enqueue({ type: 'subagent_completed', async: true } as ConversationEvent)).toBe(false);
  expect(store.enqueue(completed({ agentId: '' }))).toBe(false);
  expect(store.pendingCount).toBe(0);
});

it('records a notification for a real async registry run and nothing for its start event', async () => {
  const store = makeStore();
  const registry = new SubagentAsyncRegistry({
    logger: createMockLogger(),
    run: async ({ request }) => result({ role: request.role, finalText: 'registry output' }),
    onEvent: (event) => {
      store.enqueue(event);
    },
  });

  const handle = registry.startRun({ role: 'explorer', task: 'inspect' });
  await registry.getResult(handle.runId);

  expect(store.drain()).toEqual([
    {
      kind: 'completion',
      messageId: `completion:${handle.runId}`,
      runId: handle.runId,
      role: 'explorer',
      status: 'completed',
      preview: 'registry output',
      formattedResult: expect.stringMatching(/^Status: completed/),
      completedAt: 1_000,
    },
  ]);
  registry.dispose();
});
