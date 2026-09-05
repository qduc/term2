import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SubagentToolFactory, SubagentToolPolicy } from './tool-policy.js';
import { ToolApprovalPolicyRegistry } from '../approval/tool-approval-policy-registry.js';
import { ToolApprovalBatchCoordinator } from '../approval/tool-approval-batch-coordinator.js';
import { AgentConfiguration } from '../../lib/agent-configuration.js';
import { AgentClient } from '../../lib/agent-client.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import {
  createMockLogger,
  createMockSettings,
  createSessionContextService,
} from './test-helpers/subagent-manager-fixtures.js';

vi.mock('../session/session-composition.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session/session-composition.js')>();
  return {
    ...actual,
    createSessionRuntime: () => ({
      turns: {
        start: async function* () {
          yield { type: 'final', finalText: 'done' };
        },
      },
      state: {
        exportState: () => ({ history: [] }),
        importState: () => {},
      },
      dispose: () => {},
    }),
  };
});

import { ExecutionSubagentRunner } from './execution-runner.js';
import { createSessionRuntimeInternals } from '../session/session-composition.js';

const policyDeps = () => {
  const settings = createMockSettings();
  const logger = createMockLogger();
  const sessionContextService = createSessionContextService();
  const toolPolicy = new SubagentToolPolicy({ settings, logger, sessionContextService });
  const factory = new SubagentToolFactory({ settings, logger, toolPolicy });
  return { settings, logger, sessionContextService, factory };
};

const readDefinition = {
  role: 'explorer',
  name: 'explorer',
  instructions: 'Inspect.',
  canRead: true,
  canWrite: false,
  canSearchWeb: false,
  canRunShell: false,
  maxTurns: 1,
  model: 'test-model',
  provider: 'test-provider',
  reasoningEffort: 'default',
} as any;

const drain = async (gen: AsyncGenerator<unknown, any, void>): Promise<any> => {
  let result = await gen.next();
  while (!result.done) result = await gen.next();
  return result.value;
};

describe('subagent graph approval registry', () => {
  it('registers real subagent tool policies into the supplied graph registry', async () => {
    const { factory } = policyDeps();
    const registry = new ToolApprovalPolicyRegistry();
    const definitions = factory.buildToolDefinitions(readDefinition, [], '', false);
    expect(definitions.length).toBeGreaterThan(0);
    factory.buildAgentTools(definitions, { providerId: 'test-provider', approvalPolicyRegistry: registry });

    expect(registry.size).toBeGreaterThan(0);
    // The subagent graph's own read policy is registered: evaluation is a
    // real verdict, not the empty-registry `unknown`.
    const verdict = await registry.evaluate({ toolName: 'read_file', args: { path: 'package.json' } });
    expect(verdict.kind).not.toBe('unknown');
    await expect(new ToolApprovalPolicyRegistry().evaluate({ toolName: 'read_file', args: {} })).resolves.toEqual({
      kind: 'unknown',
    });
  });

  it('resolves a subagent interruption against the subagent graph, not the root graph or an empty registry', async () => {
    const { factory } = policyDeps();
    const subagentRegistry = new ToolApprovalPolicyRegistry();
    const rootRegistry = new ToolApprovalPolicyRegistry();
    const emptyRegistry = new ToolApprovalPolicyRegistry();
    const tool = {
      name: 'graph_policy_test',
      description: 'graph policy test',
      parameters: z.object({}),
      // The subagent graph auto-approves; the root graph holds for a human.
      needsApproval: () => false,
      execute: async () => 'ok',
      formatCommandMessage: () => [],
    };
    factory.buildAgentTools([tool as any], { providerId: 'test-provider', approvalPolicyRegistry: subagentRegistry });
    rootRegistry.register({ toolName: 'graph_policy_test', needsApproval: () => true });

    await expect(subagentRegistry.evaluate({ toolName: 'graph_policy_test', args: {} })).resolves.toEqual({
      kind: 'auto_approve',
    });
    await expect(rootRegistry.evaluate({ toolName: 'graph_policy_test', args: {} })).resolves.toEqual({
      kind: 'prompt',
    });
    await expect(emptyRegistry.evaluate({ toolName: 'graph_policy_test', args: {} })).resolves.toEqual({
      kind: 'unknown',
    });

    // The batch coordinator follows whichever registry the session resolved:
    // with the subagent graph's registry the call approves without prompting.
    const interruption = {
      name: 'graph_policy_test',
      callId: 'subagent-call-1',
      arguments: {},
      agent: { name: 'Subagent' },
    };
    const pending = {
      interruption,
      interruptions: [interruption],
      decisionsByCallId: new Map(),
      promptedCallId: 'subagent-call-1',
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
        resolveAdvisoryForInterruption: async () => ({ approved: false }),
        isUnsandboxedApprovalEligible: () => false,
      } as any,
      logger: { getCorrelationId: () => undefined } as any,
      sessionId: 'subagent-session',
      policyRegistry: subagentRegistry,
    });
    const result = await drain(
      coordinator.stageBatch({
        state: { currentState: { _context: {} }, cumulativeUsage: undefined, previouslyEmittedIds: new Set() } as any,
        interruptions: [interruption],
        policy: { decide: async () => 'prompt' } as any,
        token: 1,
      }),
    );
    expect(result.kind).toBe('ready');
    expect(pending.decisionsByCallId.get('subagent-call-1')).toBe('approved');
  });

  it('exposes the supplied subagent registry on transient clients and resolves it at session composition', () => {
    const logger = createMockLogger();
    const settings = createMockSettings({ 'agent.provider': 'test-provider', 'agent.model': 'test-model' });
    const sessionContextService = createSessionContextService();
    const registry = new ToolApprovalPolicyRegistry();
    registry.register({ toolName: 'graph_policy_test', needsApproval: () => false });
    const overrideAgent = { name: 'Subagent', model: 'test-model', instructions: '', tools: [] } as any;

    const config = new AgentConfiguration(
      { agentOverride: overrideAgent, model: 'test-model', approvalPolicyRegistry: registry },
      {
        logger,
        settings,
        sessionContextService,
        toolInterceptorRegistry: { check: async () => null } as any,
        askUserAnswerStore: { consume: () => undefined } as any,
        getSubagentBridge: () => null,
      },
    );
    expect(config.approvalPolicyRegistry).toBe(registry);

    const client = new AgentClient({
      model: 'test-model',
      deps: { logger, settings, sessionContextService },
      agentOverride: overrideAgent,
      providerOverride: 'test-provider',
      approvalPolicyRegistry: registry,
      toolOwnership: new ToolOwnershipRegistry(),
    });
    expect(client.getApprovalPolicyRegistry()).toBe(registry);

    // Session composition resolves the transient client's graph registry
    // (no supplied override, no empty fallback) for the subagent session.
    const spy = vi.spyOn(client, 'getApprovalPolicyRegistry');
    const internals = createSessionRuntimeInternals({
      sessionId: 'subagent-session',
      agentClient: client as any,
      toolOwnership: new ToolOwnershipRegistry(),
      deps: { logger, settingsService: settings as any, sessionContextService },
    });
    expect(spy).toHaveBeenCalled();
    internals.dispose();
  });

  it('threads one registry through subagent tool wrapping and transient client creation', async () => {
    const { factory } = policyDeps();
    let capturedBuildRegistry: unknown;
    let capturedClientOpts: any;
    const runner = new ExecutionSubagentRunner({
      logger: createMockLogger(),
      settings: createMockSettings(),
      sessionContextService: createSessionContextService(),
      createClient: (opts: any) => {
        capturedClientOpts = opts;
        return { dispose: vi.fn() } as any;
      },
      toolFactory: {
        buildToolDefinitions: () => [],
        buildAgentTools: (_defs: any, opts: any) => {
          capturedBuildRegistry = opts.approvalPolicyRegistry;
          return [];
        },
      } as any,
      toolOwnership: new ToolOwnershipRegistry(),
    });

    await runner.run('run-1', { role: 'explorer', task: 'inspect' } as any, readDefinition);

    expect(capturedBuildRegistry).toBeInstanceOf(ToolApprovalPolicyRegistry);
    expect(capturedClientOpts.approvalPolicyRegistry).toBe(capturedBuildRegistry);
  });
});
