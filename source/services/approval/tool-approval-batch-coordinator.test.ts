import { it, expect } from 'vitest';
import { ToolApprovalBatchCoordinator } from './tool-approval-batch-coordinator.js';
import { toolApprovalPolicyRegistry } from './tool-approval-policy-registry.js';
import { SessionAccessState } from '../session/session-access-state.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';

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
        yield;
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

it('does not auto-approve an explicit Docker host-control request', async () => {
  toolApprovalPolicyRegistry.clear();
  toolApprovalPolicyRegistry.register({ toolName: 'shell', needsApproval: async () => false });
  const interruption = {
    name: 'shell',
    callId: 'docker-shell',
    arguments: { command: 'docker ps' },
    agent: { name: 'TestAgent' },
  };
  const pending = {
    interruption,
    interruptions: [interruption],
    decisionsByCallId: new Map(),
    promptedCallId: 'docker-shell',
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
        yield;
      },
    } as any,
    shellAutoApproval: { resolveAdvisoryForInterruption: async () => ({ approved: true }) } as any,
    logger: { getCorrelationId: () => undefined } as any,
    sessionId: 's1',
  });

  const result = await drain(
    coordinator.stageBatch({
      state: { currentState: { _context: {} }, cumulativeUsage: undefined, previouslyEmittedIds: new Set() } as any,
      interruptions: [interruption],
      policy: { decide: async () => 'approve' } as any,
      token: 1,
    }),
  );

  expect(result.kind).toBe('approval_required');
  expect(appliedPlan).toBe(false);
  toolApprovalPolicyRegistry.clear();
});

it('prompts for an indirect Docker denial recorded in its injected access state', async () => {
  const interruption = { name: 'shell', callId: 'indirect', arguments: { command: 'indirect-command' }, agent: {} };
  const pending = {
    interruption,
    interruptions: [interruption],
    decisionsByCallId: new Map(),
    promptedCallId: 'indirect',
  };
  const access = new SessionAccessState(createMockSettingsService({ 'sandbox.dockerHostControlProjects': [] }));
  access.recordDockerDenial('indirect-command');
  const coordinator = new ToolApprovalBatchCoordinator({
    approvalFlow: {
      getPending: () => pending,
      retargetPendingInterruption: () => {},
      prepareContinuation: () => ({ pendingApprovalContext: pending }),
    } as any,
    planApplier: { recordPendingApproval: () => {}, applyNextPlan: async function* () {} } as any,
    shellAutoApproval: { resolveAdvisoryForInterruption: async () => ({ approved: true }) } as any,
    logger: { getCorrelationId: () => undefined } as any,
    sessionId: 'root-session',
    sessionAccess: access,
  });

  const result = await drain(
    coordinator.stageBatch({
      state: { currentState: { _context: {} }, previouslyEmittedIds: new Set() } as any,
      interruptions: [interruption],
      policy: { decide: async () => 'approve' } as any,
      token: 1,
    }),
  );

  expect(result.kind).toBe('approval_required');
});

async function drain<T>(generator: AsyncGenerator<unknown, T, void>): Promise<T> {
  let next = await generator.next();
  while (!next.done) {
    next = await generator.next();
  }
  return next.value;
}
