import { it, expect, vi, beforeEach } from 'vitest';
import type { ConversationEvent } from '../services/conversation/conversation-events.js';

/**
 * Captured SubagentManager instances. The bridge wires its own `#emitEvent`
 * into the manager's `onEvent` callback, so mocking the manager module at that
 * boundary lets these tests emit events through the exact production path.
 */
const managerInstances = vi.hoisted(() => [] as Array<{ onEvent?: (event: ConversationEvent) => void }>);

vi.mock('../services/subagents/subagent-manager.js', () => ({
  SubagentManager: class {
    onEvent?: (event: ConversationEvent) => void;
    constructor(deps: { onEvent?: (event: ConversationEvent) => void }) {
      this.onEvent = deps.onEvent;
      managerInstances.push(this);
    }
    resetMentorSession() {}
    clearCache() {}
    cancelAllAsyncRuns() {}
    resetAsyncRuns() {}
    abortAsyncRun() {}
  },
}));

const { SubagentBridge } = await import('./subagent-bridge.js');

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  security: () => {},
  setCorrelationId: () => {},
  clearCorrelationId: () => {},
  getCorrelationId: () => undefined,
  log: () => {},
};

const noopSettings = { get: () => undefined, set: () => {} };

const noopSessionContextService = {
  runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
  getContext: () => null,
};

const asyncCompletedEvent = (runId: string): ConversationEvent =>
  ({
    type: 'subagent_completed',
    async: true,
    result: { agentId: runId, status: 'completed' },
  } as unknown as ConversationEvent);

const startedEvent = (runId: string, async = false): ConversationEvent =>
  ({
    type: 'subagent_started',
    agentId: runId,
    role: 'explorer',
    task: 'inspect the project',
    parentTool: async ? 'run_subagent_async' : 'run_subagent',
    ...(async ? { async: true } : {}),
  } as ConversationEvent);

const commandEvent = (runId: string): ConversationEvent =>
  ({
    type: 'subagent_command_message',
    agentId: runId,
    role: 'explorer',
    message: { toolName: 'read_file', command: 'read_file source/app.tsx', success: true, output: '' },
  } as ConversationEvent);

/** Builds a bridge plus an `emit` function that fires the manager's onEvent. */
function makeBridge() {
  managerInstances.length = 0;
  const bridge = new SubagentBridge({
    logger: noopLogger as any,
    settings: noopSettings as any,
    sessionContextService: noopSessionContextService as any,
    chat: async () => '',
    createClient: () => ({}),
  });
  const manager = managerInstances[0];
  if (!manager?.onEvent) throw new Error('Bridge did not wire an onEvent callback into SubagentManager');
  const emit = (event: ConversationEvent) => manager.onEvent!(event);
  return { bridge, emit };
}

function collector() {
  const events: ConversationEvent[] = [];
  return { events, sink: (event: ConversationEvent) => void events.push(event) };
}

beforeEach(() => {
  managerInstances.length = 0;
});

it('delivers events to the background sink when no per-turn sink is attached', () => {
  const { bridge, emit } = makeBridge();
  const background = collector();

  bridge.setBackgroundEventSink(background.sink);
  emit(asyncCompletedEvent('run-1'));

  expect(background.events).toHaveLength(1);
  expect(background.events[0]).toMatchObject({ type: 'subagent_completed', async: true });
});

it('keeps synchronous events on the turn sink and async lifecycle events on the background sink', () => {
  const { bridge, emit } = makeBridge();
  const turn = collector();
  const background = collector();

  bridge.setEventSink(turn.sink);
  bridge.setBackgroundEventSink(background.sink);

  emit(startedEvent('foreground-run'));
  emit(commandEvent('foreground-run'));
  emit(startedEvent('background-run', true));
  emit(commandEvent('background-run'));
  emit(asyncCompletedEvent('background-run'));

  expect(turn.events.map((event) => event.type)).toEqual(['subagent_started', 'subagent_command_message']);
  expect(turn.events.every((event) => 'agentId' in event && event.agentId === 'foreground-run')).toBe(true);
  expect(background.events.map((event) => event.type)).toEqual([
    'subagent_started',
    'subagent_command_message',
    'subagent_completed',
  ]);
  expect(
    background.events.map((event) =>
      event.type === 'subagent_completed'
        ? event.result.agentId
        : 'agentId' in event && typeof event.agentId === 'string'
        ? event.agentId
        : undefined,
    ),
  ).toEqual(['background-run', 'background-run', 'background-run']);
});

it('flushes events buffered while no sink was attached to the background sink attaching first', () => {
  const { bridge, emit } = makeBridge();
  const background = collector();
  const turn = collector();

  emit(asyncCompletedEvent('run-1'));
  bridge.setBackgroundEventSink(background.sink);
  bridge.setEventSink(turn.sink);

  expect(background.events).toHaveLength(1);
  expect(turn.events).toHaveLength(0);
});

it('flushes buffered synchronous events only to the per-turn sink', () => {
  const { bridge, emit } = makeBridge();
  const background = collector();
  const turn = collector();

  emit(startedEvent('foreground-run'));
  bridge.setEventSink(turn.sink);
  bridge.setBackgroundEventSink(background.sink);

  expect(turn.events).toHaveLength(1);
  expect(background.events).toHaveLength(0);
});

it('keeps the background sink attached when the per-turn sink is cleared', () => {
  const { bridge, emit } = makeBridge();
  const turn = collector();
  const background = collector();

  bridge.setEventSink(turn.sink);
  bridge.setBackgroundEventSink(background.sink);
  bridge.setEventSink(null);
  emit(asyncCompletedEvent('run-1'));

  expect(turn.events).toHaveLength(0);
  expect(background.events).toHaveLength(1);
});

it('routes idle-time completions to the background sink instead of buffering after a turn ends', () => {
  const { bridge, emit } = makeBridge();
  const turn = collector();
  const background = collector();

  bridge.setBackgroundEventSink(background.sink);

  // Turn starts, runs, and tears its sink down exactly as the adapter does.
  bridge.setEventSink(turn.sink);
  bridge.setEventSink(null);

  // A background subagent settles while the conversation is idle.
  emit(asyncCompletedEvent('run-async'));
  expect(background.events).toHaveLength(1);

  // Nothing was buffered, so the next turn's sink sees no replay.
  const nextTurn = collector();
  bridge.setEventSink(nextTurn.sink);
  expect(nextTurn.events).toHaveLength(0);
});

it('clears the background sink when set to null', () => {
  const { bridge, emit } = makeBridge();
  const background = collector();

  bridge.setBackgroundEventSink(background.sink);
  bridge.setBackgroundEventSink(null);
  emit(asyncCompletedEvent('run-1'));

  expect(background.events).toHaveLength(0);
});
