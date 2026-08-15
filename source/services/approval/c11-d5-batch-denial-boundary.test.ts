import { it, expect } from 'vitest';
import { ToolApprovalBatchCoordinator } from './tool-approval-batch-coordinator.js';
import { toolApprovalPolicyRegistry } from './tool-approval-policy-registry.js';
import { NestedToolCompatibilityState } from '../session/nested-tool-compatibility-state.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';

const makeNestedCompatibility = () =>
  new NestedToolCompatibilityState(createMockSettingsService({ 'sandbox.dockerHostControlProjects': [] }));

async function drain<T>(generator: AsyncGenerator<unknown, T, void>): Promise<T> {
  let next = await generator.next();
  while (!next.done) {
    next = await generator.next();
  }
  return next.value;
}

// C11-D5 `record_rejected`: a batch-denied tool call must be durably recorded as an
// explicit rejection, never as approved. The batch coordinator short-circuits on any
// defined `isToolApproved` result and currently records `'approved'` even when the
// ledger says the call was denied. Ordinary form observed failure: the map holds
// 'approved' instead of 'rejected'.
it.fails('records a batch-denied tool call as rejected, not approved (C11-D5 record_rejected)', async () => {
  toolApprovalPolicyRegistry.clear();
  toolApprovalPolicyRegistry.register({ toolName: 'shell', needsApproval: async () => false });

  const interruption = {
    name: 'shell',
    callId: 'denied-call',
    arguments: { command: 'rm -rf /tmp/project-x' },
    agent: { name: 'TestAgent' },
  };
  const decisionsByCallId = new Map<string, 'approved' | 'rejected'>();
  const pending = {
    interruption,
    interruptions: [interruption],
    decisionsByCallId,
    promptedCallId: 'denied-call',
  };

  const coordinator = new ToolApprovalBatchCoordinator({
    approvalFlow: {
      getPending: () => pending,
      retargetPendingInterruption: () => {},
      prepareContinuation: () => ({ pendingApprovalContext: pending }),
    } as any,
    planApplier: {
      recordPendingApproval: () => {},
      applyNextPlan: async function* () {
        yield;
      },
    } as any,
    shellAutoApproval: {
      resolveAdvisoryForInterruption: async () => ({ approved: true, reasoning: 'safe', model: 'test' }),
      isUnsandboxedApprovalEligible: () => false,
    } as any,
    logger: { getCorrelationId: () => undefined } as any,
    sessionId: 's1',
    nestedCompatibility: makeNestedCompatibility(),
  });

  await drain(
    coordinator.stageBatch({
      state: {
        currentState: { _context: { isToolApproved: () => false } },
        cumulativeUsage: undefined,
        previouslyEmittedIds: new Set(),
      } as any,
      interruptions: [interruption],
      policy: {
        decide: async () => 'reject',
      } as any,
      token: 1,
    }),
  );

  expect(decisionsByCallId.get('denied-call')).toBe('rejected');
  toolApprovalPolicyRegistry.clear();
});
