import { it, expect } from 'vitest';
import { createSessionRuntime } from './session-composition.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';

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
                  value: { type: 'response.output_text.delta', delta: 'ok' },
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
    ...overrides,
  } as unknown as ConversationAgentClient);

it('queues async background subagent completions and notifies the observer once per novel run', () => {
  const sinks: Sinks = { turn: null, background: null };
  const runtime = createSessionRuntime({
    sessionId: 'bg-notify',
    agentClient: makeClient(sinks),
    deps: { logger: makeLogger(), sessionContextService },
  });

  let notified = 0;
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

it('projects background lifecycle changes and ignores internal activity for task observers', () => {
  const sinks: Sinks = { turn: null, background: null };
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
  sinks.background?.(completion('run-task'));

  expect(notified).toBe(2);
  expect(runtime.backgroundSubagentTasks.getSnapshot()).toEqual([
    expect.objectContaining({
      runId: 'run-task',
      role: 'worker',
      status: 'completed',
    }),
  ]);

  runtime.dispose();
});

it('detaches the background sink on disposal', () => {
  const sinks: Sinks = { turn: null, background: null };
  const runtime = createSessionRuntime({
    sessionId: 'bg-dispose',
    agentClient: makeClient(sinks),
    deps: { logger: makeLogger(), sessionContextService },
  });

  expect(typeof sinks.background).toBe('function');
  runtime.dispose();
  expect(sinks.background).toBeNull();
});
