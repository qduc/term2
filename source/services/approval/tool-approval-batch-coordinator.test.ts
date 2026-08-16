import { it, expect } from 'vitest';
import { ToolApprovalBatchCoordinator } from './tool-approval-batch-coordinator.js';
import { toolApprovalPolicyRegistry } from './tool-approval-policy-registry.js';
import { SessionAccessState } from '../session/session-access-state.js';
import { NestedToolCompatibilityState } from '../session/nested-tool-compatibility-state.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';

const makeNestedCompatibility = () =>
  new NestedToolCompatibilityState(createMockSettingsService({ 'sandbox.dockerHostControlProjects': [] }));

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
      isUnsandboxedApprovalEligible: () => false,
    } as any,
    logger: { getCorrelationId: () => undefined } as any,
    sessionId: 's1',
    nestedCompatibility: makeNestedCompatibility(),
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
    shellAutoApproval: {
      resolveAdvisoryForInterruption: async () => ({ approved: true }),
      isUnsandboxedApprovalEligible: () => false,
    } as any,
    logger: { getCorrelationId: () => undefined } as any,
    sessionId: 's1',
    nestedCompatibility: makeNestedCompatibility(),
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
    shellAutoApproval: {
      resolveAdvisoryForInterruption: async () => ({ approved: true }),
      isUnsandboxedApprovalEligible: () => false,
    } as any,
    logger: { getCorrelationId: () => undefined } as any,
    sessionId: 'root-session',
    sessionAccess: access,
    nestedCompatibility: makeNestedCompatibility(),
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

const makeShellInterruption = (callId: string, command: string, sandbox?: string) => ({
  name: 'shell',
  callId,
  arguments: sandbox ? { command, sandbox } : { command },
  agent: { name: 'TestAgent' },
});

const makePending = (interruption: any) => ({
  interruption,
  interruptions: [interruption],
  decisionsByCallId: new Map<string, 'approved' | 'rejected'>(),
  promptedCallId: interruption.callId,
});

const runBatch = async (
  interruption: any,
  opts: {
    eligible?: boolean;
    policyDecision?: 'approve' | 'prompt';
    registryAutoApprove?: boolean;
    mode?: 'off' | 'always';
  } = {},
) => {
  if (opts.registryAutoApprove) {
    toolApprovalPolicyRegistry.clear();
    toolApprovalPolicyRegistry.register({
      toolName: 'shell',
      needsApproval: async () => false,
    });
  }
  const pending = makePending(interruption);
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
      resolveAdvisoryForInterruption: async () => ({
        approved: true,
        reasoning: 'safe',
        model: 'test',
        source: 'llm',
      }),
      isUnsandboxedApprovalEligible: () => opts.eligible === true,
      getAutoApproveMode: () => opts.mode ?? 'off',
    } as any,
    logger: { getCorrelationId: () => undefined } as any,
    sessionId: 's1',
    nestedCompatibility: makeNestedCompatibility(),
  });
  const result = await drain(
    coordinator.stageBatch({
      state: { currentState: { _context: {} }, cumulativeUsage: undefined, previouslyEmittedIds: new Set() } as any,
      interruptions: [interruption],
      policy: { decide: async () => opts.policyDecision ?? 'prompt' } as any,
      token: 1,
    }),
  );
  toolApprovalPolicyRegistry.clear();
  return { result, appliedPlan };
};

it('always mode auto-approves editor interruptions in a continuation batch', async () => {
  const { result, appliedPlan } = await runBatch(
    {
      name: 'apply_patch',
      callId: 'batch-patch-yolo',
      arguments: { operations: [{ type: 'create_file', path: '../outside.txt', diff: '@@ -0,0 +1 @@\n+x' }] },
      agent: { name: 'TestAgent' },
    },
    { mode: 'always', policyDecision: 'prompt' },
  );

  expect(result.kind).toBe('ready');
  expect(appliedPlan).toBe(true);
});

it('unsandboxed shell in a batch auto-approves via LLM when eligible and the policy approves', async () => {
  const { result, appliedPlan } = await runBatch(
    makeShellInterruption('batch-unsandboxed', 'curl https://example.com', 'unsandboxed'),
    { eligible: true, policyDecision: 'approve' },
  );

  expect(result.kind).toBe('ready');
  expect(appliedPlan).toBe(true);
});

it('unsandboxed shell in a batch prompts when eligible but the policy declines', async () => {
  const { result, appliedPlan } = await runBatch(
    makeShellInterruption('batch-unsandboxed-declined', 'curl https://example.com', 'unsandboxed'),
    { eligible: true, policyDecision: 'prompt' },
  );

  expect(result.kind).toBe('approval_required');
  expect(appliedPlan).toBe(false);
});

it('unsandboxed shell in a batch is never auto-approved by the registry even when LLM-eligible', async () => {
  const { result, appliedPlan } = await runBatch(
    makeShellInterruption('batch-unsandboxed-registry', 'curl https://example.com', 'unsandboxed'),
    { eligible: true, policyDecision: 'prompt', registryAutoApprove: true },
  );

  expect(result.kind).toBe('approval_required');
  expect(appliedPlan).toBe(false);
});

it('unsandboxed shell in a batch prompts when not eligible even if the policy approves', async () => {
  const { result, appliedPlan } = await runBatch(
    makeShellInterruption('batch-unsandboxed-ineligible', 'curl https://example.com', 'unsandboxed'),
    { eligible: false, policyDecision: 'approve' },
  );

  expect(result.kind).toBe('approval_required');
  expect(appliedPlan).toBe(false);
});

it('mixed batch: sandboxed shell auto-approves while unsandboxed shell prompts', async () => {
  const sandboxed = makeShellInterruption('batch-sandboxed', 'ls');
  const unsandboxed = makeShellInterruption('batch-mixed-unsandboxed', 'curl https://example.com', 'unsandboxed');
  const pending = makePending(unsandboxed);
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
      resolveAdvisoryForInterruption: async (input: { interruption: any }) =>
        input.interruption.callId === 'batch-sandboxed'
          ? { approved: true, reasoning: 'safe', model: 'test', source: 'llm' }
          : { approved: false, reasoning: 'risky', model: 'test', source: 'llm' },
      isUnsandboxedApprovalEligible: () => true,
    } as any,
    logger: { getCorrelationId: () => undefined } as any,
    sessionId: 's1',
    nestedCompatibility: makeNestedCompatibility(),
  });

  const result = await drain(
    coordinator.stageBatch({
      state: { currentState: { _context: {} }, cumulativeUsage: undefined, previouslyEmittedIds: new Set() } as any,
      interruptions: [sandboxed, unsandboxed],
      policy: {
        decide: async (ctx: { callId?: string }) => (ctx.callId === 'batch-sandboxed' ? 'approve' : 'prompt'),
      } as any,
      token: 1,
    }),
  );

  expect(result.kind).toBe('approval_required');
  expect(appliedPlan).toBe(true);
  if (result.kind === 'approval_required' && result.terminal.type === 'approval_required') {
    expect(result.terminal.approval.callId).toBe('batch-mixed-unsandboxed');
  }
  toolApprovalPolicyRegistry.clear();
});

async function drain<T>(generator: AsyncGenerator<unknown, T, void>): Promise<T> {
  let next = await generator.next();
  while (!next.done) {
    next = await generator.next();
  }
  return next.value;
}
