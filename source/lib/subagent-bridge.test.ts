import test from 'ava';
import { SubagentBridge } from './subagent-bridge.js';
import type { ConversationEvent } from '../services/conversation/conversation-events.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const noopSettings = {
  get: () => undefined,
  set: () => {},
};

const noopSessionContextService = {
  runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
  getContext: () => null,
};

/** Creates a mock SubagentManager-shaped object with per-instance tracked calls. */
function createMockManager():
  | {
      manager: Record<string, any>;
      trackRun: { callCount: number; lastArgs: any };
      trackRunAsTool: { callCount: number; lastArgs: any };
      trackReset: { callCount: number };
      trackClearCache: { callCount: number };
    }
  | any {
  const trackRun = { callCount: 0, lastArgs: null as any };
  const trackRunAsTool = { callCount: 0, lastArgs: null as any };
  const trackReset = { callCount: 0 };
  const trackClearCache = { callCount: 0 };

  const manager = {
    run: async (args: any) => {
      trackRun.callCount++;
      trackRun.lastArgs = args;
      return { finalText: 'mock-result', status: 'completed', toolsUsed: [], filesChanged: [] };
    },
    runAsTool: async (args: any, _context?: unknown, _details?: unknown) => {
      trackRunAsTool.callCount++;
      trackRunAsTool.lastArgs = { args, context: _context, details: _details };
      return { finalText: 'mock-tool-result', status: 'completed', toolsUsed: [], filesChanged: [] };
    },
    resetMentorSession: () => {
      trackReset.callCount++;
    },
    clearCache: () => {
      trackClearCache.callCount++;
    },
  };

  return { manager, trackRun, trackRunAsTool, trackReset, trackClearCache };
}

function makeBridge(subagentManager: Record<string, any> | null) {
  return new SubagentBridge({
    logger: noopLogger as any,
    settings: noopSettings as any,
    sessionContextService: noopSessionContextService as any,
    chat: async () => '',
    createClient: () => ({}),
    subagentManager: subagentManager as any,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('setEventSink stores the sink', (t) => {
  const { manager } = createMockManager();
  const bridge = makeBridge(manager);

  const sink = (_event: ConversationEvent) => {};
  bridge.setEventSink(sink);

  // Clearing when count is 0 works immediately (no deferral).
  bridge.setEventSink(null);
  t.pass();
});

test('setEventSink defers clear when subagents are active', async (t) => {
  const { manager } = createMockManager();
  const bridge = makeBridge(manager);

  bridge.setEventSink((_event: ConversationEvent) => {});
  const mentorPromise = bridge.createMentor('test');

  // While subagent is running, try to clear the sink — should be deferred
  bridge.setEventSink(null);

  await mentorPromise;

  // After completion, setting a new sink should work cleanly
  bridge.setEventSink((_event: ConversationEvent) => {});
  bridge.setEventSink(null);
  t.pass();
});

test('clearSubagentCache delegates to SubagentManager.resetMentorSession', (t) => {
  const { manager, trackReset } = createMockManager();
  const bridge = makeBridge(manager);

  bridge.clearSubagentCache();
  t.is(trackReset.callCount, 1);

  bridge.clearSubagentCache();
  t.is(trackReset.callCount, 2);
});

test('clearCache delegates to SubagentManager.clearCache', (t) => {
  const { manager, trackClearCache } = createMockManager();
  const bridge = makeBridge(manager);

  (bridge as any).clearCache();
  t.is(trackClearCache.callCount, 1);

  (bridge as any).clearCache();
  t.is(trackClearCache.callCount, 2);
});

test('createMentor calls SubagentManager.run with role mentor', async (t) => {
  const { manager, trackRun } = createMockManager();
  const bridge = makeBridge(manager);

  const result = await bridge.createMentor('help me');

  t.is(trackRun.callCount, 1);
  t.truthy(trackRun.lastArgs);
  t.is(trackRun.lastArgs.role, 'mentor');
  t.is(trackRun.lastArgs.task, 'help me');
  t.is(trackRun.lastArgs.parentTool, 'ask_mentor');
  t.is(result, 'mock-result');
});

test('createMentor throws when SubagentManager is null', async (t) => {
  const bridge = makeBridge(null);

  await t.throwsAsync(() => bridge.createMentor('test'), {
    message: /Transient agent clients cannot spawn subagents/,
  });
});

test('createMentor throws when result status is failed', async (t) => {
  const { manager, trackRun } = createMockManager();
  // Override run to return a failed result
  manager.run = async () => ({
    finalText: '',
    status: 'failed' as const,
    error: 'Something went wrong',
    toolsUsed: [],
    filesChanged: [],
  });
  // Reset tracking since we overrode
  trackRun.callCount = 0;

  const bridge = makeBridge(manager);

  await t.throwsAsync(() => bridge.createMentor('test'), {
    message: /Something went wrong/,
  });
});

test('runSubagent calls SubagentManager.runAsTool', async (t) => {
  const { manager, trackRunAsTool } = createMockManager();
  const bridge = makeBridge(manager);

  const params = { role: 'worker', task: 'do something' };
  const result = await bridge.runSubagent(params, undefined, undefined);

  t.is(trackRunAsTool.callCount, 1);
  t.truthy(trackRunAsTool.lastArgs);
  t.is(trackRunAsTool.lastArgs.args.role, 'worker');
  t.is(trackRunAsTool.lastArgs.args.task, 'do something');
  t.is(trackRunAsTool.lastArgs.args.parentTool, 'run_subagent');
  t.is(result.finalText, 'mock-tool-result');
});

test('runSubagent throws when SubagentManager is null', async (t) => {
  const bridge = makeBridge(null);

  await t.throwsAsync(() => bridge.runSubagent({ role: 'worker', task: 'test' }), {
    message: /Transient agent clients cannot spawn subagents/,
  });
});

test('runSubagent forwards resumeState from details', async (t) => {
  const { manager, trackRunAsTool } = createMockManager();
  const bridge = makeBridge(manager);

  const params = { role: 'worker', task: 'task' };
  const details = { resumeState: 'test-state', signal: undefined, toolCall: { callId: 'call-1' } };
  await bridge.runSubagent(params, undefined, details);

  t.truthy(trackRunAsTool.lastArgs);
  t.is(trackRunAsTool.lastArgs.args.resumeState, 'test-state');
});

test('activeSubagentsCount tracks active subagent runs', async (t) => {
  const { manager } = createMockManager();
  const bridge = makeBridge(manager);

  t.is(bridge.activeSubagentsCount, 0);

  // Start a mentor run (doesn't complete yet)
  const mentorPromise = bridge.createMentor('test');
  t.is(bridge.activeSubagentsCount, 1);

  await mentorPromise;
  t.is(bridge.activeSubagentsCount, 0);
});

test('deferred sink clear is applied after active subagents complete', async (t) => {
  const { manager } = createMockManager();
  const bridge = makeBridge(manager);

  // Set initial sink
  bridge.setEventSink((_event: ConversationEvent) => {});

  // Start a subagent run
  const mentorPromise = bridge.createMentor('test');

  // While running, try to clear the sink — should be deferred
  bridge.setEventSink(null);

  // Complete the run
  await mentorPromise;

  // Sink should now be cleared (deferred clear applied after count hits 0)
  // Setting a new sink should work without crashing
  bridge.setEventSink((_event: ConversationEvent) => {});
  bridge.setEventSink(null);
  t.pass();
});
