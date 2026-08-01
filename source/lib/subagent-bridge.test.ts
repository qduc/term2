import { it, expect } from 'vitest';
import { SubagentBridge as ProductionSubagentBridge } from './subagent-bridge.js';
import { SessionContextService } from '../services/session/session-context-service.js';
import type { ConversationEvent } from '../services/conversation/conversation-events.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';

class SubagentBridge extends ProductionSubagentBridge {
  constructor(options: Omit<ConstructorParameters<typeof ProductionSubagentBridge>[0], 'toolOwnership'>) {
    super({ ...options, toolOwnership: new ToolOwnershipRegistry() });
  }
}

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

function makeTrafficContext(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    sessionStartedAt: '2026-06-21T14:20:00.000Z',
    mode: 'standard',
    traceId: 'trace-1',
    ...overrides,
  };
}

/** Creates a mock SubagentManager-shaped object with per-instance tracked calls. */
function createMockManager():
  | {
      manager: Record<string, any>;
      trackRun: { callCount: number; lastArgs: any };
      trackRunAsTool: { callCount: number; lastArgs: any };
      trackReset: { callCount: number };
      trackClearCache: { callCount: number };
      trackDispose: { callCount: number };
    }
  | any {
  const trackRun = { callCount: 0, lastArgs: null as any };
  const trackRunAsTool = { callCount: 0, lastArgs: null as any };
  const trackStartRunAsync = { callCount: 0, lastArgs: null as any };
  const trackGetRunResult = { callCount: 0, lastArgs: null as any };
  const trackSendMessage = { callCount: 0, lastArgs: null as any };
  const trackCancelRun = { callCount: 0, lastArgs: null as any };
  const trackCancelAllAsyncRuns = { callCount: 0 };
  const trackReset = { callCount: 0 };
  const trackClearCache = { callCount: 0 };
  const trackDispose = { callCount: 0 };

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
    startRunAsync: (args: any) => {
      trackStartRunAsync.callCount++;
      trackStartRunAsync.lastArgs = args;
      return { runId: args.runId ?? 'run-1', role: args.role, task: args.task, status: 'running' };
    },
    getRunResult: async (args: any) => {
      trackGetRunResult.callCount++;
      trackGetRunResult.lastArgs = args;
      return { finalText: 'async-result', status: 'completed', toolsUsed: [], filesChanged: [] };
    },
    sendMessageToAsyncRun: (args: any) => {
      trackSendMessage.callCount++;
      trackSendMessage.lastArgs = args;
      return { ok: true, runId: 'run-1', status: 'running', delivery: 'queued' };
    },
    cancelAsyncRun: (target: string) => {
      trackCancelRun.callCount++;
      trackCancelRun.lastArgs = target;
      return { ok: true, runId: 'run-1', status: 'cancelling' };
    },
    cancelAllAsyncRuns: () => {
      trackCancelAllAsyncRuns.callCount++;
    },
    resetMentorSession: () => {
      trackReset.callCount++;
    },
    clearCache: () => {
      trackClearCache.callCount++;
    },
    dispose: () => {
      trackDispose.callCount++;
    },
  };

  return {
    manager,
    trackRun,
    trackRunAsTool,
    trackStartRunAsync,
    trackGetRunResult,
    trackSendMessage,
    trackCancelRun,
    trackCancelAllAsyncRuns,
    trackReset,
    trackClearCache,
    trackDispose,
  };
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

// Sink attach/clear and buffered-event flushing are covered behaviourally in
// subagent-bridge.background-sink.test.ts, which drives the real `onEvent`
// callback rather than an injected manager.

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

it('dispose cancels session work and clears manager-owned state once', () => {
  const { manager, trackCancelAllAsyncRuns, trackClearCache, trackReset, trackDispose } = createMockManager();
  const bridge = makeBridge(manager);

  bridge.dispose();
  bridge.dispose();

  expect(trackCancelAllAsyncRuns.callCount).toBe(1);
  expect(trackClearCache.callCount).toBe(1);
  expect(trackReset.callCount).toBe(1);
  expect(trackDispose.callCount).toBe(1);
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

it('createMentor passes the bridge abort signal to SubagentManager.run', async () => {
  const { manager, trackRun } = createMockManager();
  const bridge = makeBridge(manager);

  await bridge.createMentor('help me');

  expect(trackRun.lastArgs.signal).toBe(bridge.signal);
});

it('runSubagent passes the bridge abort signal to SubagentManager.runAsTool', async () => {
  const { manager, trackRunAsTool } = createMockManager();
  const bridge = makeBridge(manager);

  await bridge.runSubagent({ role: 'worker', task: 'do something' });

  expect(trackRunAsTool.lastArgs.args.signal).toBe(bridge.signal);
});

it('runSubagent still forwards resumeState from details', async () => {
  const { manager, trackRunAsTool } = createMockManager();
  const bridge = makeBridge(manager);

  const params = { role: 'worker', task: 'task' };
  const details = { resumeState: 'test-state', signal: undefined, toolCall: { callId: 'call-1' } };
  await bridge.runSubagent(params, undefined, details);

  expect(trackRunAsTool.lastArgs.args.resumeState).toBe('test-state');
  expect(trackRunAsTool.lastArgs.args.signal).toBe(bridge.signal);
});

it('runSubagent scopes provider history to the subagent tool call', async () => {
  const sessionContextService = new SessionContextService();
  const seenContexts: Array<Record<string, unknown> | null> = [];

  const manager = {
    run: async () => ({ finalText: 'mock-result', status: 'completed', toolsUsed: [], filesChanged: [] }),
    runAsTool: async (_args: any, _context?: unknown, _details?: unknown) => {
      seenContexts.push(sessionContextService.getContext());
      return { finalText: 'mock-tool-result', status: 'completed', toolsUsed: [], filesChanged: [] };
    },
    resetMentorSession: () => {},
    clearCache: () => {},
  };

  const bridge = new SubagentBridge({
    logger: noopLogger as any,
    settings: noopSettings as any,
    sessionContextService: sessionContextService as any,
    chat: async () => '',
    createClient: () => ({}),
    subagentManager: manager as any,
  });

  const parentContext = makeTrafficContext();
  await sessionContextService.runWithContext(parentContext as any, async () => {
    await bridge.runSubagent({ role: 'worker', task: 'inspect the repository' }, undefined, {
      toolCall: { callId: 'call-explorer-1' },
    });
  });

  expect(seenContexts).toEqual([
    expect.objectContaining({
      sessionId: 'session-1',
      sessionStartedAt: '2026-06-21T14:20:00.000Z',
      mode: 'standard',
      traceId: 'trace-1',
      providerHistoryKey: 'session-1:subagent:call-explorer-1',
    }),
  ]);
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

it('abort aborts active subagent runs', async () => {
  const { manager } = createMockManager();
  const bridge = makeBridge(manager);

  let capturedSignal: AbortSignal | undefined;
  manager.run = async (args: any) => {
    capturedSignal = args.signal;
    return new Promise((resolve) => {
      const listener = () => {
        resolve({
          status: 'cancelled',
          finalText: '',
          toolsUsed: [],
          filesChanged: [],
          error: 'aborted',
        });
      };
      args.signal?.addEventListener('abort', listener, { once: true });
    });
  };

  const mentorPromise = bridge.createMentor('test');
  expect(bridge.signal.aborted).toBe(false);

  bridge.abort();

  await expect(mentorPromise).rejects.toMatchObject({ name: 'AbortError' });
  expect(capturedSignal?.aborted).toBe(true);
});

it('createMentor rejects cancelled manager results as AbortError', async () => {
  const { manager } = createMockManager();
  manager.run = async () => ({
    status: 'cancelled',
    finalText: '',
    filesChanged: [],
    toolsUsed: [],
  });

  const bridge = makeBridge(manager);

  await expect(bridge.createMentor('test')).rejects.toMatchObject({ name: 'AbortError' });
});

it('resetAbortController replaces the shared abort controller', () => {
  const { manager } = createMockManager();
  const bridge = makeBridge(manager);

  const firstSignal = bridge.signal;
  bridge.resetAbortController();
  const secondSignal = bridge.signal;

  expect(secondSignal).not.toBe(firstSignal);
  expect(secondSignal.aborted).toBe(false);
});

it('getAgentRuntime returns null when SubagentManager is null', () => {
  const bridge = makeBridge(null);
  expect(bridge.getAgentRuntime()).toBeNull();
});

it('getAgentRuntime returns the AgentRuntime from SubagentManager', () => {
  const mockRuntime = { agent: () => ({ run: async () => ({}) }) };
  const manager = {
    ...createMockManager().manager,
    getAgentRuntime: () => mockRuntime,
  };
  const bridge = makeBridge(manager);

  const runtime = bridge.getAgentRuntime();
  expect(runtime).toBeDefined();
  expect(runtime).toBe(mockRuntime);
  expect(typeof (runtime as any).agent).toBe('function');
});

it('runSubagentAsync delegates to SubagentManager.startRunAsync', async () => {
  const { manager, trackStartRunAsync } = createMockManager();
  const bridge = makeBridge(manager);

  const handle = await bridge.runSubagentAsync({ role: 'explorer', task: 'find files' });

  expect(trackStartRunAsync.callCount).toBe(1);
  expect(trackStartRunAsync.lastArgs.role).toBe('explorer');
  expect(trackStartRunAsync.lastArgs.task).toBe('find files');
  expect(trackStartRunAsync.lastArgs.parentTool).toBe('run_subagent_async');
  expect(handle.role).toBe('explorer');
  expect(handle.task).toBe('find files');
});

it('runSubagentAsync forwards an optional active-run name to the registry request', async () => {
  const { manager, trackStartRunAsync } = createMockManager();
  const bridge = makeBridge(manager);

  await bridge.runSubagentAsync({ role: 'explorer', task: 'find files', name: 'code_scan' });

  expect(trackStartRunAsync.lastArgs.name).toBe('code_scan');
});

it('runSubagentAsync passes the bridge abort signal to startRunAsync', async () => {
  const { manager, trackStartRunAsync } = createMockManager();
  const bridge = makeBridge(manager);

  await bridge.runSubagentAsync({ role: 'researcher', task: 'look up docs' });

  expect(trackStartRunAsync.lastArgs.signal).toBeInstanceOf(AbortSignal);
});

it('runSubagentAsync keeps event sink alive until the async run completes', async () => {
  const { manager } = createMockManager();
  const bridge = makeBridge(manager);

  bridge.setEventSink((_event: ConversationEvent) => {});
  const handle = await bridge.runSubagentAsync({ role: 'explorer', task: 'find files' });

  expect(bridge.activeSubagentsCount).toBe(0);
});

it('getSubagentResult delegates to SubagentManager.getRunResult', async () => {
  const { manager, trackGetRunResult } = createMockManager();
  const bridge = makeBridge(manager);

  const result = await bridge.getSubagentResult({ runId: 'run-123' });

  expect(trackGetRunResult.callCount).toBe(1);
  expect(trackGetRunResult.lastArgs).toBe('run-123');
  expect(result.status).toBe('completed');
});

it('public async controls delegate non-blockingly while transient bridges reject them', () => {
  const { manager, trackSendMessage, trackCancelRun } = createMockManager();
  const bridge = makeBridge(manager);

  expect(bridge.sendSubagentMessage({ target: 'scan', message: 'Use the public API.', reply_to: 'message-1' })).toEqual(
    {
      ok: true,
      runId: 'run-1',
      status: 'running',
      delivery: 'queued',
    },
  );
  expect(trackSendMessage.lastArgs).toEqual({ target: 'scan', message: 'Use the public API.', reply_to: 'message-1' });
  expect(bridge.cancelSubagentRun({ target: 'scan' })).toEqual({ ok: true, runId: 'run-1', status: 'cancelling' });
  expect(trackCancelRun.lastArgs).toBe('scan');

  const transient = makeBridge(null);
  expect(() => transient.sendSubagentMessage({ target: 'scan', message: 'Nope.' })).toThrow(/Transient agent clients/);
  expect(() => transient.cancelSubagentRun({ target: 'scan' })).toThrow(/Transient agent clients/);
});

it('cancelAsyncRuns delegates to SubagentManager.cancelAllAsyncRuns', () => {
  const { manager, trackCancelAllAsyncRuns } = createMockManager();
  const bridge = makeBridge(manager);

  bridge.cancelAsyncRuns();

  expect(trackCancelAllAsyncRuns.callCount).toBe(0);
});

it('runSubagentAsync throws when SubagentManager is null', async () => {
  const bridge = makeBridge(null);

  await expect(bridge.runSubagentAsync({ role: 'explorer', task: 'test' })).rejects.toThrow(
    /Transient agent clients cannot spawn subagents/,
  );
});

it('getSubagentResult throws when SubagentManager is null', async () => {
  const bridge = makeBridge(null);

  await expect(bridge.getSubagentResult({ runId: 'run-1' })).rejects.toThrow(
    /Transient agent clients cannot spawn subagents/,
  );
});
