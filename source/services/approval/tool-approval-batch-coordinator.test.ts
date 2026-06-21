import { it, expect } from 'vitest';
import { ToolApprovalBatchCoordinator } from './tool-approval-batch-coordinator.js';
import { toolApprovalPolicyRegistry } from './tool-approval-policy-registry.js';

it('prompts for unsandboxed shell even when the registry would auto-approve', async () => {
  toolApprovalPolicyRegistry.clear();
  toolApprovalPolicyRegistry.register({
    toolName: 'shell',
    needsApproval: async () => false,
  });

  const interruption = {
    name: 'shell',
    callId: 'unsandboxed-shell',
    arguments: { command: 'curl https://example.com', sandbox: 'unsandboxed' },
    agent: { name: 'TestAgent' },
  };
  const decisionsByCallId = new Map<string, 'approved' | 'rejected'>();
  const pending = {
    interruption,
    interruptions: [interruption],
    decisionsByCallId,
    promptedCallId: 'unsandboxed-shell',
  };
  let appliedPlan = false;

  const coordinator = new ToolApprovalBatchCoordinator({
    approvalFlow: {
      getPending: () => pending,
      retargetPendingInterruption: () => {},
      prepareContinuation: () => ({ pendingApprovalContext: pending }),
    } as any,
    planApplier: {
      recordPendingApproval: () => {},
      applyNextPlan: async function* () {
        appliedPlan = true;
      },
    } as any,
    shellAutoApproval: {
      resolveAdvisoryForInterruption: async () => ({ approved: true, reasoning: 'safe', model: 'test' }),
    } as any,
    logger: { getCorrelationId: () => undefined } as any,
    sessionId: 's1',
  });

  const result = await drain(
    coordinator.stageBatch({
      state: {
        currentState: { _context: {} },
        cumulativeUsage: undefined,
        previouslyEmittedIds: new Set(),
      } as any,
      interruptions: [interruption],
      policy: {
        decide: async () => 'prompt',
      } as any,
      token: 1,
    }),
  );

  expect(result.kind).toBe('approval_required');
  if (result.kind === 'approval_required' && result.terminal.type === 'approval_required') {
    expect(result.terminal.approval.callId).toBe('unsandboxed-shell');
  }
  expect(appliedPlan).toBe(false);
  toolApprovalPolicyRegistry.clear();
});

async function drain<T>(generator: AsyncGenerator<unknown, T, void>): Promise<T> {
  let next = await generator.next();
  while (!next.done) {
    next = await generator.next();
  }
  return next.value;
}
