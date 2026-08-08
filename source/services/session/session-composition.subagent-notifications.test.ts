import { it, expect } from 'vitest';
import { createSessionRuntime as createProductionSessionRuntime } from './session-composition.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';

const createSessionRuntime = (options: Omit<Parameters<typeof createProductionSessionRuntime>[0], 'toolOwnership'>) =>
  createProductionSessionRuntime({ ...options, toolOwnership: new ToolOwnershipRegistry() });

const noop = () => {};

const makeLogger = () => ({
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  security: noop,
  setCorrelationId: noop,
  getCorrelationId: () => undefined,
  clearCorrelationId: noop,
});

const sessionContextService = {
  runWithContext: (_ctx: any, fn: () => any) => fn(),
  getContext: () => null,
};

const completion = (agentId: string, async = true): ConversationEvent =>
  ({
    type: 'subagent_completed',
    async,
    result: {
      agentId,
      role: 'explorer',
      status: 'completed',
      finalText: 'found it',
      filesChanged: [],
      toolsUsed: [],
    },
  } as ConversationEvent);

const question = (messageId: string, runId = 'run-1'): ConversationEvent =>
  ({
    type: 'subagent_question',
    async: true,
    messageId,
    runId,
    role: 'explorer',
    question: 'Which public API should I use?',
  } as ConversationEvent);

const start = (agentId: string): ConversationEvent =>
  ({
    type: 'subagent_started',
    agentId,
    role: 'worker',
    task: 'implement the panel',
    parentTool: 'run_subagent_async',
    async: true,
  } as ConversationEvent);

type Sinks = {
  turn: ((event: ConversationEvent) => void) | null;
  background: ((event: ConversationEvent) => void) | null;
  shell: ((event: ConversationEvent) => void) | null;
};

const makeClient = (sinks: Sinks, overrides: Record<string, unknown> = {}) =>
  ({
    async startStream(_input: any, _opts: any) {
      return {
        interruptions: [],
        state: null,
        history: [],
        newItems: [],
        finalOutput: 'ok',
        lastResponseId: null,
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            next() {
              if (!done) {
                done = true;
                return Promise.resolve({
                  done: false,
                  value: { type: 'text_delta', text: 'ok' },
                });
              }
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      };
    },
    abort: noop,
    continueRunStream: noop as any,
    setModel: noop as any,
    addToolInterceptor: noop as any,
    chat: noop as any,
    setSubagentEventSink: (sink: ((event: ConversationEvent) => void) | null) => {
      sinks.turn = sink;
    },
    setBackgroundSubagentEventSink: (sink: ((event: ConversationEvent) => void) | null) => {
      sinks.background = sink;
    },
    setBackgroundShellEventSink: (sink: ((event: ConversationEvent) => void) | null) => {
      sinks.shell = sink;
    },
    ...overrides,
  } as unknown as ConversationAgentClient);

it('queues async background subagent completions and notifies the observer once per novel run', () => {
  const sinks: Sinks = { turn: null, background: null, shell: null };
  const runtime = createSessionRuntime({
    sessionId: 'bg-notify',
    agentClient: makeClient(sinks),
    deps: { logger: makeLogger(), sessionContextService },
  });

  let notified = 0;
  const logged: any[] = [];
  runtime.logs.setLogSink((event) => logged.push(event));
  runtime.backgroundSubagentNotifications.setObserver(() => {
    notified += 1;
  });

  sinks.background?.(completion('run-1'));
  sinks.background?.(completion('run-1'));
  sinks.background?.(completion('run-2', false));

  expect(notified).toBe(1);
  expect(runtime.backgroundSubagentNotifications.pendingCount).toBe(1);
  expect(runtime.backgroundSubagentNotifications.drain()).toEqual([
    expect.objectContaining({ runId: 'run-1', role: 'explorer', status: 'completed' }),
  ]);

  runtime.dispose();
});

it('routes async subagent questions through the background queue and observer', () => {
  const sinks: Sinks = { turn: null, background: null, shell: null };
  const runtime = createSessionRuntime({
    sessionId: 'bg-question',
    agentClient: makeClient(sinks),
    deps: { logger: makeLogger(), sessionContextService },
  });
  let notified = 0;
  const logged: any[] = [];
  runtime.logs.setLogSink((event) => logged.push(event));
  runtime.backgroundSubagentNotifications.setObserver(() => {
    notified += 1;
  });

  sinks.background?.(question('question-1'));
  sinks.background?.(question('question-1'));
  sinks.background?.(question('question-2'));

  expect(notified).toBe(2);
  expect(runtime.backgroundSubagentNotifications.drain()).toEqual([
    expect.objectContaining({ kind: 'question', messageId: 'question-1', runId: 'run-1' }),
    expect.objectContaining({ kind: 'question', messageId: 'question-2', runId: 'run-1' }),
  ]);
  expect(logged).toContainEqual(
    expect.objectContaining({ type: 'subagent_question', messageId: 'question-1', runId: 'run-1' }),
  );
  runtime.dispose();
});

it('projects background starts, tool activity, and completions to task observers', () => {
  const sinks: Sinks = { turn: null, background: null, shell: null };
  const runtime = createSessionRuntime({
    sessionId: 'bg-tasks',
    agentClient: makeClient(sinks),
    deps: { logger: makeLogger(), sessionContextService },
  });
  let notified = 0;
  runtime.backgroundSubagentTasks.setObserver(() => {
    notified += 1;
  });

  sinks.background?.(start('run-task'));
  expect(runtime.backgroundSubagentTasks.getSnapshot()).toEqual([
    expect.objectContaining({
      runId: 'run-task',
      role: 'worker',
      task: 'implement the panel',
      status: 'running',
    }),
  ]);

  sinks.background?.({
    type: 'subagent_tool_started',
    agentId: 'run-task',
    role: 'worker',
    toolCallId: 'tool-1',
    toolName: 'read_file',
  } as ConversationEvent);
  expect(runtime.backgroundSubagentTasks.getSnapshot()).toEqual([
    expect.objectContaining({ lastTool: { label: 'read_file', state: 'running' } }),
  ]);

  sinks.background?.(completion('run-task'));

  expect(notified).toBe(3);
  expect(runtime.backgroundSubagentTasks.getSnapshot()).toEqual([
    expect.objectContaining({
      runId: 'run-task',
      role: 'worker',
      status: 'completed',
    }),
  ]);

  runtime.dispose();
});

it('detaches the background sink on disposal', async () => {
  const sinks: Sinks = { turn: null, background: null, shell: null };
  const runtime = createSessionRuntime({
    sessionId: 'bg-dispose',
    agentClient: makeClient(sinks),
    deps: { logger: makeLogger(), sessionContextService },
  });

  expect(typeof sinks.background).toBe('function');
  runtime.dispose();
  await Promise.resolve();
  expect(sinks.background).toBeNull();
  expect(sinks.shell).toBeNull();
});

it('routes root background shell lifecycle through the persistent task and notification channels', () => {
  const sinks: Sinks = { turn: null, background: null, shell: null };
  const runtime = createSessionRuntime({
    sessionId: 'bg-shell',
    agentClient: makeClient(sinks),
    deps: { logger: makeLogger(), sessionContextService },
  });
  let notifications = 0;
  runtime.backgroundSubagentNotifications.setObserver(() => notifications++);

  sinks.shell?.({ type: 'background_shell_started', jobId: 'shell-1', command: 'safe-hold' });
  sinks.shell?.({
    type: 'background_shell_completed',
    jobId: 'shell-1',
    command: 'safe-hold',
    status: 'completed',
    output: 'done',
  });

  expect(runtime.backgroundSubagentTasks.getSnapshot()).toEqual([
    expect.objectContaining({ kind: 'shell', jobId: 'shell-1', status: 'completed' }),
  ]);
  expect(runtime.backgroundSubagentNotifications.drain()).toEqual([
    expect.objectContaining({ kind: 'shell_completion', jobId: 'shell-1', output: 'done' }),
  ]);
  expect(notifications).toBe(1);
  runtime.dispose();
});

it('exposes per-item background controls through the session runtime and wakes both observers on a stop request', () => {
  const sinks: Sinks = { turn: null, background: null, shell: null };
  let stopCalls = 0;
  const runtime = createSessionRuntime({
    sessionId: 'bg-control',
    agentClient: makeClient(sinks, {
      getBackgroundSubagentStatus: (runId: string) => ({
        runId,
        name: 'scan',
        role: 'explorer',
        status: 'running',
        task: 'inspect the implementation',
        taskPreview: 'inspect the implementation',
        startedAt: 100,
        elapsedMs: 20,
        toolCounts: {},
      }),
      requestBackgroundSubagentStop: () => {
        stopCalls++;
        return { ok: true, runId: 'run-1', status: 'cancelling' };
      },
    }),
    deps: { logger: makeLogger(), sessionContextService },
  });
  let notifications = 0;
  let taskChanges = 0;
  runtime.backgroundSubagentNotifications.setObserver(() => notifications++);
  runtime.backgroundSubagentTasks.setObserver(() => taskChanges++);

  expect(runtime.backgroundTaskControl.requestStop({ kind: 'subagent', id: 'run-1' })).toEqual({
    ok: true,
    details: expect.objectContaining({ id: 'run-1', status: 'cancelling' }),
  });
  expect(stopCalls).toBe(1);
  expect(notifications).toBe(1);
  expect(taskChanges).toBe(1);
  expect(runtime.backgroundSubagentNotifications.drain()).toEqual([
    expect.objectContaining({ kind: 'user_control', action: 'stop', target: { kind: 'subagent', id: 'run-1' } }),
  ]);
  runtime.dispose();
});

it('delivers a successful foreground-shell move as planning input at the next request boundary', () => {
  const sinks: Sinks = { turn: null, background: null, shell: null };
  const runtime = createSessionRuntime({
    sessionId: 'foreground-shell-move',
    agentClient: makeClient(sinks, {
      getForegroundShellTransferCandidate: () => ({
        callId: 'call-1',
        jobId: 'shell-1',
        command: 'pnpm test',
        status: 'running',
        startedAt: 100,
      }),
      moveForegroundShellToBackground: () => ({ jobId: 'shell-1', status: 'running' }),
      getBackgroundShellJob: () => ({
        id: 'shell-1',
        command: 'pnpm test',
        status: 'running',
        startedAt: 100,
      }),
    }),
    deps: { logger: makeLogger(), sessionContextService },
  });
  let notifications = 0;
  runtime.backgroundSubagentNotifications.setObserver(() => notifications++);

  expect(runtime.backgroundTaskControl.moveForegroundToBackground({ kind: 'shell', callId: 'call-1' })).toEqual({
    ok: true,
    details: expect.objectContaining({ id: 'shell-1', command: 'pnpm test' }),
  });
  expect(notifications).toBe(1);
  expect(runtime.backgroundSubagentNotifications.drain()).toEqual([
    expect.objectContaining({
      kind: 'user_control',
      action: 'background',
      target: { kind: 'shell', id: 'shell-1' },
    }),
  ]);
  runtime.dispose();
});

it('disposal cancels and shutdown settles root background shell jobs', async () => {
  const sinks: Sinks = { turn: null, background: null, shell: null };
  let cancelCalls = 0;
  let disposeCalls = 0;
  let releaseSettlement!: () => void;
  const runtime = createSessionRuntime({
    sessionId: 'bg-shell-dispose',
    agentClient: makeClient(sinks, {
      cancelBackgroundShellJobs: () => cancelCalls++,
      disposeBackgroundShellJobs: async () => {
        disposeCalls++;
        await new Promise<void>((resolve) => {
          releaseSettlement = resolve;
        });
      },
    }),
    deps: { logger: makeLogger(), sessionContextService },
  });

  let settled = false;
  const shutdown = runtime.shutdown().then(() => {
    settled = true;
  });
  await Promise.resolve();

  expect(cancelCalls).toBe(1);
  expect(disposeCalls).toBe(1);
  expect(settled).toBe(false);
  expect(typeof sinks.shell).toBe('function');
  releaseSettlement();
  await shutdown;
  expect(sinks.shell).toBeNull();
});
