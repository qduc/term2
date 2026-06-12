import test from 'ava';
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

test('resetSession clears approval state through approvalFlow and keeps persistence on providerContinuity', (t) => {
  const { calls, deps, providerContinuity } = makeLifecycleHarness();
  const lifecycle = new SessionLifecycle(deps as any);

  t.false('previousResponseId' in lifecycle);
  t.is(lifecycle.exportPersistedState().previousResponseId, 'resp-123');

  lifecycle.resetSession();

  t.is(calls.approvalFlow.clearPending, 1);
  t.is(calls.approvalFlow.consumeAborted, 1);
  t.is(calls.approvalState.clearPending, 0);
  t.is(calls.approvalState.consumeAborted, 0);
  t.is(calls.providerContinuity.clear, 1);
  t.is(calls.providerContinuity.update, 0);
  t.is(calls.statusMachine.abort, 1);
  t.is(calls.generationGuard.invalidate, 1);
  t.is(calls.agentClient.clearConversations, 1);
  t.is(lifecycle.exportPersistedState().previousResponseId, null);
  t.is(providerContinuity.previousResponseId, null);
});

test('afterUndo routes approval cleanup through approvalFlow coordinator', (t) => {
  const { calls, deps } = makeLifecycleHarness();
  const lifecycle = new SessionLifecycle(deps as any);

  lifecycle.afterUndo();

  t.is(calls.approvalFlow.clearPending, 1);
  t.is(calls.approvalFlow.consumeAborted, 1);
  t.is(calls.approvalState.clearPending, 0);
  t.is(calls.approvalState.consumeAborted, 0);
  t.is(calls.toolTracker.pruneToCurrentHistory, 1);
  t.is(calls.inputPlanner.markUndoOrRewind, 1);
  t.is(calls.statusMachine.abort, 1);
  t.is(calls.agentClient.clearConversations, 1);
});

test('importPersistedState clears approval state through approvalFlow coordinator', (t) => {
  const { calls, deps, providerContinuity } = makeLifecycleHarness();
  const lifecycle = new SessionLifecycle(deps as any);

  lifecycle.importPersistedState({
    history: [],
    previousResponseId: 'resp-imported',
    toolLedger: [],
    updatedAt: '2024-01-01T00:00:00.000Z',
  });

  t.is(calls.approvalFlow.clearPending, 1);
  t.is(calls.approvalFlow.consumeAborted, 1);
  t.is(calls.approvalState.clearPending, 0);
  t.is(calls.approvalState.consumeAborted, 0);
  t.is(calls.providerContinuity.clear, 1);
  t.is(calls.providerContinuity.update, 0);
  t.is(calls.inputPlanner.reset, 1);
  t.is(calls.inputPlanner.markResumedSession, 1);
  t.is(calls.turnAccumulator.resetPersistedTurnState, 1);
  t.is(calls.statusMachine.abort, 1);
  t.is(providerContinuity.previousResponseId, null);
});
