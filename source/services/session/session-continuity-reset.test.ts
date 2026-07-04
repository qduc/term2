import { expect, it } from 'vitest';
import { SessionContinuityReset } from './session-continuity-reset.js';

const makeHarness = () => {
  const calls = {
    providerContinuity: { clear: 0 },
    approvalFlow: { clearPending: 0, consumeAborted: 0 },
    toolTracker: { clearArguments: 0, clearEmittedToolStarted: 0 },
    shellAutoApproval: { clearCache: 0 },
    inputPlanner: { reset: 0 },
    turnAccumulator: { resetPersistedTurnState: 0 },
    agentClient: { clearConversations: 0 },
  };

  const reset = new SessionContinuityReset({
    providerContinuity: {
      clear: () => {
        calls.providerContinuity.clear++;
      },
    } as any,
    approvalFlow: {
      clearPending: () => {
        calls.approvalFlow.clearPending++;
      },
      consumeAborted: () => {
        calls.approvalFlow.consumeAborted++;
        return null;
      },
    } as any,
    toolTracker: {
      clearArguments: () => {
        calls.toolTracker.clearArguments++;
      },
      clearEmittedToolStarted: () => {
        calls.toolTracker.clearEmittedToolStarted++;
      },
    } as any,
    shellAutoApproval: {
      clearCache: () => {
        calls.shellAutoApproval.clearCache++;
      },
    } as any,
    inputPlanner: {
      reset: () => {
        calls.inputPlanner.reset++;
      },
    } as any,
    turnAccumulator: {
      resetPersistedTurnState: () => {
        calls.turnAccumulator.resetPersistedTurnState++;
      },
    } as any,
    agentClient: {
      clearConversations: () => {
        calls.agentClient.clearConversations++;
      },
    } as any,
  });

  return { calls, reset };
};

it('reset clears continuity, approval, cache, and persisted turn state', () => {
  const { calls, reset } = makeHarness();

  reset.reset();

  expect(calls.providerContinuity.clear).toBe(1);
  expect(calls.approvalFlow.clearPending).toBe(1);
  expect(calls.approvalFlow.consumeAborted).toBe(1);
  expect(calls.toolTracker.clearArguments).toBe(1);
  expect(calls.toolTracker.clearEmittedToolStarted).toBe(1);
  expect(calls.shellAutoApproval.clearCache).toBe(1);
  expect(calls.inputPlanner.reset).toBe(1);
  expect(calls.turnAccumulator.resetPersistedTurnState).toBe(1);
  expect(calls.agentClient.clearConversations).toBe(1);
});

it('reset can preserve provider conversations when requested', () => {
  const { calls, reset } = makeHarness();

  reset.reset({ clearConversations: false });

  expect(calls.providerContinuity.clear).toBe(1);
  expect(calls.approvalFlow.clearPending).toBe(1);
  expect(calls.approvalFlow.consumeAborted).toBe(1);
  expect(calls.toolTracker.clearArguments).toBe(1);
  expect(calls.toolTracker.clearEmittedToolStarted).toBe(1);
  expect(calls.shellAutoApproval.clearCache).toBe(1);
  expect(calls.inputPlanner.reset).toBe(1);
  expect(calls.turnAccumulator.resetPersistedTurnState).toBe(1);
  expect(calls.agentClient.clearConversations).toBe(0);
});
