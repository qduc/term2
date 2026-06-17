import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { SessionLifecycle } from './session-lifecycle.js';

const makeLifecycleHarness = () => {
  const calls = {
    approvalFlow: { clearPending: 0, consumeAborted: 0 },
    approvalState: { clearPending: 0, consumeAborted: 0 },
    providerContinuity: { clear: 0, update: 0 },
    generationGuard: { invalidate: 0 },
    conversationStore: { clear: 0, addImportedItem: 0 },
    toolTracker: {
      reset: 0,
      import: 0,
      clearArguments: 0,
      clearEmittedToolStarted: 0,
      pruneToCurrentHistory: 0,
      getReconciledHistory: 0,
      export: 0,
    },
    shellAutoApproval: { clearCache: 0 },
    turnAccumulator: { resetPersistedTurnState: 0 },
    inputPlanner: { reset: 0, markUndoOrRewind: 0, markResumedSession: 0 },
    agentClient: { clearConversations: 0 },
    statusMachine: { abort: 0 },
    logger: { warn: 0 },
  };

  const approvalFlow = {
    clearPending: () => {
      calls.approvalFlow.clearPending++;
    },
    consumeAborted: () => {
      calls.approvalFlow.consumeAborted++;
      return null;
    },
    getPending: () => null,
  };

  const approvalState = {
    clearPending: () => {
      calls.approvalState.clearPending++;
    },
    consumeAborted: () => {
      calls.approvalState.consumeAborted++;
      return null;
    },
  };

  const providerContinuity = {
    previousResponseId: 'resp-123' as string | null,
    update: (id: string | null) => {
      calls.providerContinuity.update++;
      providerContinuity.previousResponseId = id;
    },
    clear: () => {
      calls.providerContinuity.clear++;
      providerContinuity.previousResponseId = null;
    },
    breakChaining: () => undefined,
    isChainingAvailable: () => true,
  };

  const deps = {
    inputPlanner: {
      reset: () => {
        calls.inputPlanner.reset++;
      },
      markUndoOrRewind: () => {
        calls.inputPlanner.markUndoOrRewind++;
      },
      markResumedSession: () => {
        calls.inputPlanner.markResumedSession++;
      },
    },
    approvalState,
    approvalFlow,
    toolTracker: {
      reset: () => {
        calls.toolTracker.reset++;
      },
      import: () => {
        calls.toolTracker.import++;
      },
      clearArguments: () => {
        calls.toolTracker.clearArguments++;
      },
      clearEmittedToolStarted: () => {
        calls.toolTracker.clearEmittedToolStarted++;
      },
      pruneToCurrentHistory: () => {
        calls.toolTracker.pruneToCurrentHistory++;
      },
      getReconciledHistory: () => {
        calls.toolTracker.getReconciledHistory++;
        return [];
      },
      export: () => {
        calls.toolTracker.export++;
        return [];
      },
    },
    shellAutoApproval: {
      clearCache: () => {
        calls.shellAutoApproval.clearCache++;
      },
    },
    turnAccumulator: {
      resetPersistedTurnState: () => {
        calls.turnAccumulator.resetPersistedTurnState++;
      },
    },
    conversationStore: {
      clear: () => {
        calls.conversationStore.clear++;
      },
      addImportedItem: () => {
        calls.conversationStore.addImportedItem++;
      },
    },
    agentClient: {
      clearConversations: () => {
        calls.agentClient.clearConversations++;
      },
    },
    logger: {
      warn: () => {
        calls.logger.warn++;
      },
    },
    sessionId: 'session-1',
    appState: {
      statusMachine: {
        abort: () => {
          calls.statusMachine.abort++;
        },
      },
    },
    providerContinuity,
    generationGuard: {
      invalidate: () => {
        calls.generationGuard.invalidate++;
      },
    },
  };

  return { calls, deps, providerContinuity };
};

it('resetSession clears approval state through approvalFlow and keeps persistence on providerContinuity', () => {
  const { calls, deps, providerContinuity } = makeLifecycleHarness();
  const lifecycle = new SessionLifecycle(deps as any);

  expect('previousResponseId' in lifecycle).toBe(false);
  expect(lifecycle.exportPersistedState().previousResponseId).toBe('resp-123');

  lifecycle.resetSession();

  expect(calls.approvalFlow.clearPending).toBe(1);
  expect(calls.approvalFlow.consumeAborted).toBe(1);
  expect(calls.approvalState.clearPending).toBe(0);
  expect(calls.approvalState.consumeAborted).toBe(0);
  expect(calls.providerContinuity.clear).toBe(1);
  expect(calls.providerContinuity.update).toBe(0);
  expect(calls.statusMachine.abort).toBe(1);
  expect(calls.generationGuard.invalidate).toBe(1);
  expect(calls.agentClient.clearConversations).toBe(1);
  expect(lifecycle.exportPersistedState().previousResponseId).toBe(null);
  expect(providerContinuity.previousResponseId).toBe(null);
});

it('afterUndo routes approval cleanup through approvalFlow coordinator', () => {
  const { calls, deps } = makeLifecycleHarness();
  const lifecycle = new SessionLifecycle(deps as any);

  lifecycle.afterUndo();

  expect(calls.approvalFlow.clearPending).toBe(1);
  expect(calls.approvalFlow.consumeAborted).toBe(1);
  expect(calls.approvalState.clearPending).toBe(0);
  expect(calls.approvalState.consumeAborted).toBe(0);
  expect(calls.toolTracker.pruneToCurrentHistory).toBe(1);
  expect(calls.inputPlanner.markUndoOrRewind).toBe(1);
  expect(calls.statusMachine.abort).toBe(1);
  expect(calls.agentClient.clearConversations).toBe(1);
});

it('importPersistedState clears approval state through approvalFlow coordinator', () => {
  const { calls, deps, providerContinuity } = makeLifecycleHarness();
  const lifecycle = new SessionLifecycle(deps as any);

  lifecycle.importPersistedState({
    history: [],
    previousResponseId: 'resp-imported',
    toolLedger: [],
    updatedAt: '2024-01-01T00:00:00.000Z',
  });

  expect(calls.approvalFlow.clearPending).toBe(1);
  expect(calls.approvalFlow.consumeAborted).toBe(1);
  expect(calls.approvalState.clearPending).toBe(0);
  expect(calls.approvalState.consumeAborted).toBe(0);
  expect(calls.providerContinuity.clear).toBe(1);
  expect(calls.providerContinuity.update).toBe(0);
  expect(calls.inputPlanner.reset).toBe(1);
  expect(calls.inputPlanner.markResumedSession).toBe(1);
  expect(calls.turnAccumulator.resetPersistedTurnState).toBe(1);
  expect(calls.statusMachine.abort).toBe(1);
  expect(providerContinuity.previousResponseId).toBe(null);
});
