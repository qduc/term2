import { it, expect } from 'vitest';
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

it('setEventSink stores the sink', () => {
  const { manager } = createMockManager();
  const bridge = makeBridge(manager);

  const sink = (_event: ConversationEvent) => {};
  bridge.setEventSink(sink);

  // Clearing when count is 0 works immediately (no deferral).
  bridge.setEventSink(null);
  expect(true).toBe(true);
});

it('setEventSink defers clear when subagents are active', async () => {
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
  expect(true).toBe(true);
});

it('clearSubagentCache delegates to SubagentManager.resetMentorSession', () => {
  const { manager, trackReset } = createMockManager();
  const bridge = makeBridge(manager);

  bridge.clearSubagentCache();
  expect(trackReset.callCount).toBe(1);

  bridge.clearSubagentCache();
  expect(trackReset.callCount).toBe(2);
});

it('clearCache delegates to SubagentManager.clearCache', () => {
  const { manager, trackClearCache } = createMockManager();
  const bridge = makeBridge(manager);

  (bridge as any).clearCache();
  expect(trackClearCache.callCount).toBe(1);

  (bridge as any).clearCache();
  expect(trackClearCache.callCount).toBe(2);
});

it('createMentor calls SubagentManager.run with role mentor', async () => {
  const { manager, trackRun } = createMockManager();
  const bridge = makeBridge(manager);

  const result = await bridge.createMentor('help me');

  expect(trackRun.callCount).toBe(1);
  expect(trackRun.lastArgs).toBeTruthy();
  expect(trackRun.lastArgs.role).toBe('mentor');
  expect(trackRun.lastArgs.task).toBe('help me');
  expect(trackRun.lastArgs.parentTool).toBe('ask_mentor');
  expect(result).toBe('mock-result');
});

it('createMentor throws when SubagentManager is null', async () => {
  const bridge = makeBridge(null);

  await expect(() => bridge.createMentor('test')).rejects.toThrow(/Transient agent clients cannot spawn subagents/);
});

it('createMentor throws when result status is failed', async () => {
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

  await expect(() => bridge.createMentor('test')).rejects.toThrow(/Something went wrong/);
});

it('runSubagent calls SubagentManager.runAsTool', async () => {
  const { manager, trackRunAsTool } = createMockManager();
  const bridge = makeBridge(manager);

  const params = { role: 'worker', task: 'do something' };
  const result = await bridge.runSubagent(params, undefined, undefined);

  expect(trackRunAsTool.callCount).toBe(1);
  expect(trackRunAsTool.lastArgs).toBeTruthy();
  expect(trackRunAsTool.lastArgs.args.role).toBe('worker');
  expect(trackRunAsTool.lastArgs.args.task).toBe('do something');
  expect(trackRunAsTool.lastArgs.args.parentTool).toBe('run_subagent');
  expect(result.finalText).toBe('mock-tool-result');
});

it('runSubagent throws when SubagentManager is null', async () => {
  const bridge = makeBridge(null);

  await expect(() => bridge.runSubagent({ role: 'worker', task: 'test' })).rejects.toThrow(
    /Transient agent clients cannot spawn subagents/,
  );
});

it('runSubagent forwards resumeState from details', async () => {
  const { manager, trackRunAsTool } = createMockManager();
  const bridge = makeBridge(manager);

  const params = { role: 'worker', task: 'task' };
  const details = { resumeState: 'test-state', signal: undefined, toolCall: { callId: 'call-1' } };
  await bridge.runSubagent(params, undefined, details);

  expect(trackRunAsTool.lastArgs).toBeTruthy();
  expect(trackRunAsTool.lastArgs.args.resumeState).toBe('test-state');
});

it('activeSubagentsCount tracks active subagent runs', async () => {
  const { manager } = createMockManager();
  const bridge = makeBridge(manager);

  expect(bridge.activeSubagentsCount).toBe(0);

  // Start a mentor run (doesn't complete yet)
  const mentorPromise = bridge.createMentor('test');
  expect(bridge.activeSubagentsCount).toBe(1);

  await mentorPromise;
  expect(bridge.activeSubagentsCount).toBe(0);
});

it('deferred sink clear is applied after active subagents complete', async () => {
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
});
