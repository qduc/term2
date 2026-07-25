import { it, expect } from 'vitest';
import { createSessionRuntime } from './session-composition.js';
import { createConversationRuntime } from '../conversation/conversation-runtime-factory.js';
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

it('does not double-render: a completion during an active turn reaches the UI sink exactly once', async () => {
  const sinks: Sinks = { turn: null, background: null };
  const client = makeClient(sinks, {
    async startStream(_input: any, _opts: any) {
      // The SubagentBridge fans a single emission out to both sinks.
      const event = completion('run-1');
      sinks.turn?.(event);
      sinks.background?.(event);
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
  });

  const { runtime, adapter } = createConversationRuntime({
    sessionId: 'bg-no-double-render',
    agentClient: client,
    deps: { logger: makeLogger(), sessionContextService },
  });

  const seen: ConversationEvent[] = [];
  await adapter.sendMessage('hi', { onEvent: (event) => seen.push(event) });

  expect(seen.filter((event) => event.type === 'subagent_completed')).toHaveLength(1);
  expect(runtime.backgroundSubagentNotifications.pendingCount).toBe(1);

  runtime.dispose();
});
