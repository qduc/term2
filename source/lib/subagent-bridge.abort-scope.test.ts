import { it, expect } from 'vitest';
import { SubagentBridge } from './subagent-bridge.js';

/**
 * Background (async) subagent runs are conversation-bound: they must survive
 * the turn that launched them and every ordinary per-turn abort. Only an
 * explicit background cancellation may stop them.
 */

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

function createMockManager() {
  const foregroundSignals: AbortSignal[] = [];
  const backgroundSignals: AbortSignal[] = [];
  const calls = { cancelAllAsyncRuns: 0 };

  const manager = {
    run: async (args: any) => {
      foregroundSignals.push(args.signal);
      return { finalText: 'mentor', status: 'completed', toolsUsed: [], filesChanged: [] };
    },
    runAsTool: async (args: any) => {
      foregroundSignals.push(args.signal);
      return { finalText: 'tool', status: 'completed', toolsUsed: [], filesChanged: [] };
    },
    startRunAsync: (args: any) => {
      backgroundSignals.push(args.signal);
      return { runId: 'run-1', role: args.role, task: args.task, status: 'running' };
    },
    getRunResult: async () => ({ finalText: '', status: 'completed', toolsUsed: [], filesChanged: [] }),
    cancelAllAsyncRuns: () => {
      calls.cancelAllAsyncRuns++;
    },
    resetMentorSession: () => {},
    clearCache: () => {},
  };

  return { manager, foregroundSignals, backgroundSignals, calls };
}

function makeBridge(subagentManager: Record<string, any>) {
  return new SubagentBridge({
    logger: noopLogger as any,
    settings: noopSettings as any,
    sessionContextService: noopSessionContextService as any,
    chat: async () => '',
    createClient: () => ({}),
    subagentManager: subagentManager as any,
  });
}

it('background runs get an abort signal distinct from the per-turn foreground signal', async () => {
  const { manager, backgroundSignals } = createMockManager();
  const bridge = makeBridge(manager);

  await bridge.runSubagentAsync({ role: 'explorer', task: 'find files' });

  expect(backgroundSignals).toHaveLength(1);
  expect(backgroundSignals[0]).toBeInstanceOf(AbortSignal);
  expect(backgroundSignals[0]).not.toBe(bridge.signal);
});

it('a background run survives completion of the turn that launched it', async () => {
  const { manager, backgroundSignals, calls } = createMockManager();
  const bridge = makeBridge(manager);

  await bridge.runSubagentAsync({ role: 'explorer', task: 'find files' });
  // The next turn starts, which resets the per-turn subagent controller.
  bridge.resetAbortController();

  expect(backgroundSignals[0].aborted).toBe(false);
  expect(calls.cancelAllAsyncRuns).toBe(0);
});

it('an ordinary per-turn abort does not cancel background runs', async () => {
  const { manager, backgroundSignals, calls } = createMockManager();
  const bridge = makeBridge(manager);

  await bridge.runSubagentAsync({ role: 'explorer', task: 'find files' });
  bridge.abort();

  expect(backgroundSignals[0].aborted).toBe(false);
  expect(calls.cancelAllAsyncRuns).toBe(0);
});

it('an ordinary per-turn abort still cancels a foreground mentor run', async () => {
  const { manager, foregroundSignals } = createMockManager();
  const bridge = makeBridge(manager);

  await bridge.createMentor('why?');
  bridge.abort();

  expect(foregroundSignals).toHaveLength(1);
  expect(foregroundSignals[0].aborted).toBe(true);
});

it('an ordinary per-turn abort still cancels a foreground run_subagent run', async () => {
  const { manager, foregroundSignals } = createMockManager();
  const bridge = makeBridge(manager);

  await bridge.runSubagent({ role: 'worker', task: 'do it' });
  bridge.abort();

  expect(foregroundSignals).toHaveLength(1);
  expect(foregroundSignals[0].aborted).toBe(true);
});

it('cancelBackgroundRuns aborts the background signal and cancels live async runs', async () => {
  const { manager, backgroundSignals, calls } = createMockManager();
  const bridge = makeBridge(manager);

  await bridge.runSubagentAsync({ role: 'explorer', task: 'find files' });
  bridge.cancelBackgroundRuns();

  expect(backgroundSignals[0].aborted).toBe(true);
  expect(calls.cancelAllAsyncRuns).toBe(1);
});

it('cancelBackgroundRuns leaves the bridge usable for later background runs', async () => {
  const { manager, backgroundSignals } = createMockManager();
  const bridge = makeBridge(manager);

  await bridge.runSubagentAsync({ role: 'explorer', task: 'first' });
  bridge.cancelBackgroundRuns();
  await bridge.runSubagentAsync({ role: 'explorer', task: 'second' });

  expect(backgroundSignals[1].aborted).toBe(false);
});
