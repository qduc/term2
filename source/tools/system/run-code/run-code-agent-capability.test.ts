import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createRunCodeToolDefinition, RUN_CODE_LIMITS } from './run-code.js';
import { SubagentBridge as ProductionSubagentBridge } from '../../../lib/subagent-bridge.js';
import { ToolOwnershipRegistry } from '../../../services/approval/tool-ownership-registry.js';
import {
  createRootAgentAuthoritySnapshot,
  type AgentSpecAuthoritySnapshot,
} from '../../../services/agent-runtime/permission-boundary.js';
import { createAbortError } from '../../../services/subagents/utils.js';
import { createMockSettingsService } from '../../../services/settings/settings-service.mock.js';
import type { ILoggingService } from '../../../services/service-interfaces.js';
import type { AnyToolDefinition, ToolRegistry } from '../../types.js';
import { ToolApprovalPolicyRegistry } from '../../../services/approval/tool-approval-policy-registry.js';

class SubagentBridge extends ProductionSubagentBridge {
  constructor(options: Omit<ConstructorParameters<typeof ProductionSubagentBridge>[0], 'toolOwnership'>) {
    super({ ...options, toolOwnership: new ToolOwnershipRegistry() });
  }
}

const logging = (): ILoggingService =>
  ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), security: vi.fn() } as unknown as ILoggingService);

const noopFormatter = (() => []) as unknown as AnyToolDefinition['formatCommandMessage'];

const echoTool = (): AnyToolDefinition =>
  ({
    name: 'echo',
    description: 'test tool',
    parameters: z.object({ value: z.string() }),
    needsApproval: () => false,
    execute: (params: unknown) => `echo:${(params as { value: string }).value}`,
    formatCommandMessage: noopFormatter,
  } as AnyToolDefinition);

/**
 * Mock SubagentManager shape accepted by the real bridge. Records every
 * lifecycle call so tests can assert what the script capability actually
 * handed to the production launch seam.
 */
function createScriptManager(overrides: { runAsTool?: (...args: any[]) => Promise<unknown> } = {}) {
  const calls = {
    runAsTool: [] as Array<{ args: any; context: unknown; details: any; signalAbortedAtEntry?: boolean }>,
    startRunAsync: [] as any[],
    getRunResult: [] as Array<{ runId: string; signal: AbortSignal | undefined }>,
    getRunStatus: [] as Array<string | undefined>,
    cancelAsyncRun: [] as string[],
  };
  let activeForeground = 0;
  let maxConcurrentForeground = 0;
  const settledForeground = (args: any) => ({
    agentId: `fg-${args.task}`,
    role: 'agent',
    status: 'completed' as const,
    finalText: `done: ${args.task}`,
    filesChanged: [] as string[],
    toolsUsed: [] as Array<{ toolName: string; count: number }>,
    // Prove the script projection drops host-only bookkeeping fields.
    costRecords: [{ model: 'test-model', totalCost: 0.5 }],
    nestedRunResult: { sdk: 'opaque-object' },
  });
  const manager = {
    runAsTool:
      overrides.runAsTool ??
      (async (args: any, context: unknown, details: any) => {
        // The host aborts its controller when a run settles, so entry time is
        // the only point where the in-flight signal state is meaningful.
        calls.runAsTool.push({ args, context, details, signalAbortedAtEntry: details.signal.aborted });
        activeForeground += 1;
        maxConcurrentForeground = Math.max(maxConcurrentForeground, activeForeground);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeForeground -= 1;
        return settledForeground(args);
      }),
    startRunAsync: (args: any) => {
      calls.startRunAsync.push(args);
      return {
        runId: `async-${calls.startRunAsync.length}`,
        role: args.role,
        ...(args.name ? { name: args.name } : {}),
        status: 'running' as const,
        task: args.task,
      };
    },
    getRunResult: async (runId: string, signal?: AbortSignal) => {
      calls.getRunResult.push({ runId, signal });
      return {
        agentId: runId,
        role: 'agent',
        status: 'completed' as const,
        finalText: 'async settled',
        filesChanged: [] as string[],
        toolsUsed: [] as Array<{ toolName: string; count: number }>,
        costRecords: [{ model: 'test-model', totalCost: 0.25 }],
        nestedRunResult: { sdk: 'opaque-object' },
      };
    },
    getRunStatus: (runId?: string) => {
      calls.getRunStatus.push(runId);
      if (runId === undefined) return [];
      return {
        runId,
        role: 'agent',
        status: 'running' as const,
        task: 'async job',
        taskPreview: 'async job',
        startedAt: 0,
        elapsedMs: 5,
        toolCounts: {},
      };
    },
    sendMessageToAsyncRun: (args: any) => ({ ok: true, runId: args.target, status: 'running', delivery: 'queued' }),
    cancelAsyncRun: (target: string) => {
      calls.cancelAsyncRun.push(target);
      return { ok: true, runId: target, status: 'cancelling' as const };
    },
    cancelAllAsyncRuns: () => {},
    resetMentorSession: () => {},
    clearCache: () => {},
    dispose: () => {},
    moveForegroundSubagent: () => undefined,
    listForegroundSubagentCandidates: () => [],
    getNestedToolCompatibilityState: () => undefined,
    getAgentRuntime: () => null,
    abortAsyncRun: () => {},
    resetAsyncRuns: () => {},
    disposeAsync: () => Promise.resolve(),
  };
  return { manager, calls, maxConcurrentForeground: () => maxConcurrentForeground };
}

function makeBridge(manager: Record<string, unknown>) {
  const bridge = new SubagentBridge({
    logger: logging(),
    settings: createMockSettingsService(),
    sessionContextService: {
      getContext: () => null,
      runWithContext: (_c: unknown, fn: () => unknown) => fn(),
    } as never,
    chat: async () => '',
    createClient: () => ({}),
    subagentManager: manager as never,
  });
  // The script capability must use only the resolved-definition entry points;
  // the raw spec entry points are spies that fail loudly if reached.
  vi.spyOn(bridge, 'runSubagent').mockImplementation(async () => {
    throw new Error('raw runSubagent must not be reached from scripts');
  });
  vi.spyOn(bridge, 'runSubagentAsync').mockImplementation(async () => {
    throw new Error('raw runSubagentAsync must not be reached from scripts');
  });
  return bridge;
}

function authority(
  overrides: Partial<Parameters<typeof createRootAgentAuthoritySnapshot>[0]> = {},
): AgentSpecAuthoritySnapshot {
  return createRootAgentAuthoritySnapshot({
    effectiveTools: ['read_file', 'grep', 'glob', 'apply_patch', 'create_file', 'search_replace', 'shell'],
    limits: { maxTurns: 32, maxDepth: 1, maxChildren: 2, maxConcurrency: 2 },
    filesystemScope: { read: ['**'], write: ['docs/**'] },
    networkScope: ['example.com'],
    worktreeScope: ['alpha'],
    ...overrides,
  });
}

function scriptBridge(bridge: SubagentBridge, options: { foregroundOnly?: boolean } = {}) {
  return {
    settings: createMockSettingsService(),
    runResolvedSubagent: (params: unknown, context?: unknown, details?: unknown) =>
      bridge.runResolvedSubagent(params as never, context, details),
    ...(options.foregroundOnly
      ? {}
      : {
          runResolvedSubagentAsync: (params: unknown) => bridge.runResolvedSubagentAsync(params as never),
          getSubagentResult: (params: { runId: string }, context?: unknown, details?: unknown) =>
            bridge.getSubagentResult(params, context, details),
          getSubagentStatus: (params: { runId?: string }) => bridge.getSubagentStatus(params),
          cancelSubagentRun: (params: { target: string }) => bridge.cancelSubagentRun(params),
        }),
  };
}

function buildRunCodeTool(options: {
  bridge?: SubagentBridge;
  foregroundOnly?: boolean;
  withAuthority?: boolean;
}): AnyToolDefinition {
  const registry: ToolRegistry = [echoTool()];
  const approvalRegistry = new ToolApprovalPolicyRegistry();
  approvalRegistry.register({ toolName: 'echo', parameters: registry[0].parameters, needsApproval: () => false });
  return createRunCodeToolDefinition({
    loggingService: logging(),
    getToolRegistry: () => registry,
    getCwd: () => process.cwd(),
    approvalPolicyRegistry: approvalRegistry,
    ...(options.withAuthority === false ? {} : { agentSpecAuthority: authority() }),
    ...(options.bridge
      ? { agentSpecBridge: scriptBridge(options.bridge, { foregroundOnly: options.foregroundOnly }) as never }
      : {}),
  }) as AnyToolDefinition;
}

const execute = async (definition: AnyToolDefinition, code: string, timeoutMs = 60_000): Promise<string> =>
  String(await definition.execute({ code, timeout_ms: timeoutMs, description: 'agent capability test' } as never));

const resultJson = (output: string): any => {
  const marker = 'Result:\n';
  const start = output.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(output.slice(start + marker.length).split('\n\n')[0]);
};

const specJson = (goal: string) =>
  JSON.stringify({ goal, tools: ['read_file'], permissions: { filesystem: { read: ['**'] } } });

describe('run_code agent capability', () => {
  it('does not present a child approval interruption as a completed script agent result', async () => {
    const { manager } = createScriptManager({
      runAsTool: async () => ({
        agentId: 'approval-child',
        role: 'agent',
        status: 'interrupted',
        interrupted: true,
        finalText: '',
        filesChanged: [],
        toolsUsed: [],
      }),
    });
    const output = await execute(
      buildRunCodeTool({ bridge: makeBridge(manager) }),
      `return await agent.run({ spec: ${specJson('write pending approval')} })
        .then(() => 'FALSELY COMPLETED', (error) => error.message);`,
    );
    expect(output).not.toContain('FALSELY COMPLETED');
    expect(output).toContain('Child run interrupted (possibly awaiting a tool approval)');
  });

  it('awaits one foreground agent and forwards a resolved definition, never the raw spec', async () => {
    const { manager, calls } = createScriptManager();
    const bridge = makeBridge(manager);
    const definition = buildRunCodeTool({ bridge });

    const output = await execute(
      definition,
      `const result = await agent.run({ spec: ${specJson('Inspect the docs folder')} });\nreturn result;`,
    );

    expect(output).toContain('done: Inspect the docs folder');
    // Host-only bookkeeping must not reach the script or the model.
    expect(output).not.toContain('costRecords');
    expect(output).not.toContain('nestedRunResult');
    expect(calls.runAsTool).toHaveLength(1);
    const launched = calls.runAsTool[0];
    expect(launched.args.task).toBe('Inspect the docs folder');
    const resolved = launched.args.resolvedDefinition;
    expect(resolved).toBeTruthy();
    expect(typeof resolved.instructions).toBe('string');
    expect(resolved.isRootExecution).toBe(true);
    expect(resolved).not.toHaveProperty('goal');
    expect(bridge.runSubagent).not.toHaveBeenCalled();
    expect(bridge.runSubagentAsync).not.toHaveBeenCalled();
    expect(launched.details.toolCall.callId).toMatch(/^run_code_bridge_\d+:agent:\d+$/);
    expect(launched.details.signal).toBeDefined();
    expect(launched.signalAbortedAtEntry).toBe(false);
  });

  it('fans out concurrent foreground agents through the host bridge', async () => {
    const { manager, calls } = createScriptManager();
    const bridge = makeBridge(manager);
    const definition = buildRunCodeTool({ bridge });

    const output = await execute(
      definition,
      `const results = await Promise.all([
        agent.run({ spec: ${specJson('job-a')} }),
        agent.run({ spec: ${specJson('job-b')} }),
        agent.run({ spec: ${specJson('job-c')} }),
      ]);
      return results.map((result) => result.finalText).sort().join('|');`,
    );

    expect(output).toContain('done: job-a|done: job-b|done: job-c');
    expect(calls.runAsTool).toHaveLength(3);
    expect(calls.runAsTool.map((call) => call.args.task).sort()).toEqual(['job-a', 'job-b', 'job-c']);
  });

  it('surfaces a failed foreground child as a catchable agent.run failure without touching siblings', async () => {
    const { manager, calls } = createScriptManager({
      runAsTool: (args: any) => {
        calls.runAsTool.push({ args, context: null, details: null });
        if (args.task === 'doomed') return Promise.reject(new Error('child exploded'));
        return Promise.resolve({
          agentId: `fg-${args.task}`,
          role: 'agent',
          status: 'completed' as const,
          finalText: `done: ${args.task}`,
          filesChanged: [],
          toolsUsed: [],
        });
      },
    });
    const bridge = makeBridge(manager);
    const definition = buildRunCodeTool({ bridge });

    const output = await execute(
      definition,
      `const outcomes = await Promise.allSettled([
        agent.run({ spec: ${specJson('healthy')} }),
        agent.run({ spec: ${specJson('doomed')} }),
      ]);
      return outcomes.map((outcome) =>
        outcome.status === 'fulfilled' ? outcome.value.finalText : outcome.reason.message
      );`,
    );

    const value = resultJson(output);
    expect(value[0]).toBe('done: healthy');
    expect(value[1]).toBe('agent.run failed: child exploded');
    expect(calls.runAsTool).toHaveLength(2);
  });

  it('attenuates child authority to the bound parent snapshot per call', async () => {
    const { manager, calls } = createScriptManager();
    const bridge = makeBridge(manager);
    const definition = buildRunCodeTool({ bridge });

    const output = await execute(
      definition,
      `const widened = await agent
        .run({ spec: { goal: 'widen writes', tools: ['create_file'], permissions: { filesystem: { write: ['**'] } } } })
        .catch((error) => error.message);
      const web = await agent.run({ spec: { goal: 'browse', tools: ['web_search'] } }).catch((error) => error.message);
      const bounded = await agent.run({
        spec: { goal: 'bounded write', tools: ['create_file'], permissions: { filesystem: { write: ['docs/**'] } } },
      });
      return [widened, web, bounded.finalText];`,
    );

    const value = resultJson(output);
    expect(value[0]).toContain('Agent specification rejected');
    expect(value[0]).toContain('Filesystem write scope is explicitly empty');
    expect(value[1]).toContain('Agent specification rejected');
    expect(value[1]).toContain('finite network scope');
    // Exactly one launch happened: the in-scope sibling.
    expect(calls.runAsTool).toHaveLength(1);
    expect(calls.runAsTool[0].args.task).toBe('bounded write');
  });

  it('rejects out-of-scope worktrees before launch and forwards validated in-scope names', async () => {
    const { manager, calls } = createScriptManager();
    const bridge = makeBridge(manager);
    const definition = buildRunCodeTool({ bridge });

    const output = await execute(
      definition,
      `const rejected = await agent
        .run({ spec: ${specJson('outside')}, worktree: 'beta' })
        .catch((error) => error.message);
      const admitted = await agent.run({ spec: ${specJson('inside')}, worktree: 'alpha' });
      return [rejected, admitted.finalText];`,
    );

    const value = resultJson(output);
    expect(value[0]).toContain('Worktree "beta" is not in the parent authority scope');
    expect(value[1]).toBe('done: inside');
    expect(calls.runAsTool).toHaveLength(1);
    expect(calls.runAsTool[0].args.worktree).toBe('alpha');
  });

  it('caps agent starts per script before any manager launch; admitted siblings finish untouched', async () => {
    const { manager, calls } = createScriptManager();
    const bridge = makeBridge(manager);
    const definition = buildRunCodeTool({ bridge });

    const output = await execute(
      definition,
      `const results = await Promise.allSettled(
        Array.from({ length: ${RUN_CODE_LIMITS.maxAgentStarts + 4} }, (_, index) =>
          agent.run({ spec: { goal: 'job-' + index, tools: ['read_file'], permissions: { filesystem: { read: ['**'] } } } })
        )
      );
      return results.map((outcome) =>
        outcome.status === 'fulfilled' ? 'ok' : 'REJECTED: ' + outcome.reason.message
      );`,
      120_000,
    );

    const value = resultJson(output);
    const launched = value.filter((entry: string) => entry === 'ok');
    const rejected = value.filter((entry: string) => entry.startsWith('REJECTED: '));
    expect(launched).toHaveLength(RUN_CODE_LIMITS.maxAgentStarts);
    expect(rejected).toHaveLength(4);
    expect(rejected[0]).toContain(
      `Agent start limit reached (${RUN_CODE_LIMITS.maxAgentStarts} agent launches per script run`,
    );
    expect(calls.runAsTool).toHaveLength(RUN_CODE_LIMITS.maxAgentStarts);
  });

  it('bounds parallel foreground runs to the configured concurrency permit pool', async () => {
    const script = createScriptManager();
    const bridge = makeBridge(script.manager);
    const definition = buildRunCodeTool({ bridge });

    const output = await execute(
      definition,
      `const results = await Promise.all(
        Array.from({ length: ${RUN_CODE_LIMITS.maxAgentConcurrency * 2} }, (_, index) =>
          agent.run({ spec: { goal: 'fan-' + index, tools: ['read_file'], permissions: { filesystem: { read: ['**'] } } } })
        )
      );
      return results.length;`,
      120_000,
    );

    expect(resultJson(output)).toBe(RUN_CODE_LIMITS.maxAgentConcurrency * 2);
    expect(script.maxConcurrentForeground()).toBe(RUN_CODE_LIMITS.maxAgentConcurrency);
  });

  it('keeps the agent call ledger separate from the tools ledger in both directions', async () => {
    const { manager } = createScriptManager();
    const bridge = makeBridge(manager);
    const definition = buildRunCodeTool({ bridge });

    // Direction A: exhaust the agent ledger; tools.* stays usable.
    const agentExhausted = await execute(
      definition,
      `const rejected = [];
      for (let index = 0; index < ${RUN_CODE_LIMITS.maxAgentCalls + 5}; index += 1) {
        try {
          await agent.status({});
        } catch (error) {
          rejected.push(error.message);
        }
      }
      let echo = 'unreachable';
      try {
        echo = await tools.echo({ value: 'still-here' });
      } catch (error) {
        echo = 'FAILED: ' + error.message;
      }
      return { rejected: rejected.length, first: rejected[0] || '', echo };`,
      120_000,
    );
    const directionA = resultJson(agentExhausted);
    expect(directionA.rejected).toBe(5);
    expect(directionA.first).toContain(`Agent call limit reached (${RUN_CODE_LIMITS.maxAgentCalls}`);
    expect(directionA.echo).toBe('echo:still-here');

    // Direction B: exhaust the tools ledger; agent.* stays usable.
    const toolsExhausted = await execute(
      definition,
      `let toolRejections = 0;
      for (let index = 0; index < ${RUN_CODE_LIMITS.maxCalls + 1}; index += 1) {
        try {
          await tools.echo({ value: 'x' });
        } catch (error) {
          toolRejections += 1;
        }
      }
      let status = 'FAILED';
      try {
        await agent.status({});
        status = 'ok';
      } catch (error) {
        status = 'FAILED: ' + error.message;
      }
      return { toolRejections, status };`,
      120_000,
    );
    const directionB = resultJson(toolsExhausted);
    expect(directionB.toolRejections).toBe(1);
    expect(directionB.status).toBe('ok');
  });

  it('aborts foreground children on script timeout while background runs and their signal stay untouched', async () => {
    const calls = {
      runAsTool: [] as Array<{ args: any; details: any }>,
      startRunAsync: [] as any[],
      cancelAsyncRun: [] as string[],
    };
    const manager = {
      runAsTool: (args: any, _context: unknown, details: any) =>
        new Promise((_resolve, reject) => {
          calls.runAsTool.push({ args, details });
          details.signal.addEventListener('abort', () => reject(createAbortError()));
        }),
      startRunAsync: (args: any) => {
        calls.startRunAsync.push(args);
        return { runId: 'async-1', role: args.role, name: args.name, status: 'running' as const, task: args.task };
      },
      getRunResult: async () => ({
        agentId: 'async-1',
        role: 'agent',
        status: 'completed' as const,
        finalText: 'async settled',
        filesChanged: [],
        toolsUsed: [],
      }),
      getRunStatus: () => [],
      sendMessageToAsyncRun: () => ({ ok: true, runId: 'async-1', status: 'running', delivery: 'queued' }),
      cancelAsyncRun: (target: string) => {
        calls.cancelAsyncRun.push(target);
        return { ok: true, runId: target, status: 'cancelling' as const };
      },
      cancelAllAsyncRuns: () => {},
      resetMentorSession: () => {},
      clearCache: () => {},
      dispose: () => {},
      moveForegroundSubagent: () => undefined,
      listForegroundSubagentCandidates: () => [],
      getNestedToolCompatibilityState: () => undefined,
      getAgentRuntime: () => null,
      abortAsyncRun: () => {},
      resetAsyncRuns: () => {},
      disposeAsync: () => Promise.resolve(),
    };
    const bridge = makeBridge(manager);
    const definition = buildRunCodeTool({ bridge });

    const output = await execute(
      definition,
      `const handle = await agent.start({ spec: ${specJson('retained job')}, name: 'keeper' });
      await agent.run({ spec: ${specJson('foreground hang')} });
      return handle.runId;`,
      1_000,
    );

    expect(output).toContain('Script timed out');
    expect(calls.runAsTool).toHaveLength(1);
    expect(calls.runAsTool[0].details.signal.aborted).toBe(true);
    // The background run is conversation-scoped: not aborted, not cancelled.
    expect(bridge.backgroundSignal.aborted).toBe(false);
    expect(calls.startRunAsync).toHaveLength(1);
    expect(calls.cancelAsyncRun).toHaveLength(0);
  });

  it('supports the async lifecycle: start, status, result, and cancel', async () => {
    const { manager, calls } = createScriptManager();
    const bridge = makeBridge(manager);
    const definition = buildRunCodeTool({ bridge });

    const output = await execute(
      definition,
      `const handle = await agent.start({ spec: ${specJson('async job')}, name: 'peeked' });
      const status = await agent.status({ runId: handle.runId });
      const result = await agent.result({ runId: handle.runId });
      const cancel = await agent.cancel({ target: handle.runId });
      return { handle, status, result, cancel };`,
    );

    const value = resultJson(output);
    expect(value.handle).toEqual({ runId: 'async-1', name: 'peeked', role: 'agent', status: 'running' });
    expect(value.status.status).toBe('running');
    expect(value.status.runId).toBe('async-1');
    expect(value.result.finalText).toBe('async settled');
    expect(value.result.costRecords).toBeUndefined();
    expect(value.result.nestedRunResult).toBeUndefined();
    expect(value.cancel).toEqual({ ok: true, runId: 'async-1', status: 'cancelling' });
    // The async launch must use the conversation-scoped background signal.
    expect(calls.startRunAsync).toHaveLength(1);
    expect(calls.startRunAsync[0].signal).toBe(bridge.backgroundSignal);
    expect(calls.startRunAsync[0].task).toBe('async job');
    expect(calls.startRunAsync[0].name).toBe('peeked');
    expect(calls.startRunAsync[0].resolvedDefinition).toBeTruthy();
    expect(calls.cancelAsyncRun).toEqual(['async-1']);
    expect(bridge.runSubagentAsync).not.toHaveBeenCalled();
    expect(output).toContain('agent.start [');
    expect(output).toContain('applied');
  });

  it('rejects script continuation instead of inheriting a stored run definition', async () => {
    const { manager, calls } = createScriptManager();
    const bridge = makeBridge(manager);
    const definition = buildRunCodeTool({ bridge });

    const output = await execute(
      definition,
      `const rejection = await agent.start({
        spec: ${specJson('continue with read-only tools')},
        continue_run_id: 'completed-broader-run',
      }).catch((error) => error.message);
      return rejection;`,
    );

    expect(output).toContain('continue_run_id is not supported');
    expect(calls.startRunAsync).toHaveLength(0);
  });

  it('includes successful agent launches in the host call ledger', async () => {
    const { manager } = createScriptManager();
    const definition = buildRunCodeTool({ bridge: makeBridge(manager) });

    const output = await execute(
      definition,
      `await agent.run({ spec: ${specJson('account this launch')} });
      throw new Error('script failed after launch');`,
    );

    expect(output).toContain('agent.run');
    expect(output).toContain('1 tool call');
  });

  it('records an unknown background launch when the script times out before receiving its handle', async () => {
    const { manager } = createScriptManager();
    const dispatched: unknown[] = [];
    (manager as any).startRunAsync = (args: unknown) => {
      dispatched.push(args);
      return new Promise(() => {});
    };
    const definition = buildRunCodeTool({ bridge: makeBridge(manager) });

    const output = await execute(
      definition,
      `await agent.start({ spec: ${specJson('background launch with delayed handle')} });
      return 'unreachable';`,
      1_000,
    );

    expect(output).toContain('Script timed out');
    expect(output).toContain('agent.start');
    expect(output).toContain('unknown');
    expect(output).toContain('did not settle before the script run ended');
    expect(dispatched).toHaveLength(1);
  });

  it('reports unobserved agent failures through the host unhandled-rejection lane with the agent prefix', async () => {
    const { manager } = createScriptManager({
      runAsTool: () => Promise.reject(new Error('child exploded')),
    });
    const bridge = makeBridge(manager);
    const definition = buildRunCodeTool({ bridge });

    // Fire-and-forget: the rejection is never observed by the script, so it
    // must surface through the host unhandled-rejection lane, not as a script
    // body error.
    const output = await execute(definition, `agent.run({ spec: ${specJson('doomed')} });\nreturn 'fired';`);

    expect(output).toContain('unhandled_nested_failure');
    expect(output).toContain('agent.run failed: child exploded');
  });

  it('validates launch and lifecycle parameters before admission', async () => {
    const { manager, calls } = createScriptManager();
    const bridge = makeBridge(manager);
    const definition = buildRunCodeTool({ bridge });

    const output = await execute(
      definition,
      `const noSpec = await agent.run({}).catch((error) => error.message);
      const badWorktree = await agent.run({ spec: ${specJson('w')}, worktree: 7 }).catch((error) => error.message);
      const nameOnRun = await agent.run({ spec: ${specJson('n')}, name: 'n' }).catch((error) => error.message);
      const badStatus = await agent.status({ runId: 7 }).catch((error) => error.message);
      const badResult = await agent.result({}).catch((error) => error.message);
      const badCancel = await agent.cancel({}).catch((error) => error.message);
      return [noSpec, badWorktree, nameOnRun, badStatus, badResult, badCancel];`,
    );

    const value = resultJson(output);
    expect(value[0]).toContain('spec');
    expect(value[1]).toContain('worktree');
    expect(value[2]).toContain('name');
    expect(value[2]).toContain('agent.run');
    expect(value[3]).toContain('runId');
    expect(value[4]).toContain('runId');
    expect(value[5]).toContain('target');
    expect(calls.runAsTool).toHaveLength(0);
    expect(calls.startRunAsync).toHaveLength(0);
  });

  it('describes the agent capability only when authority and bridge are both bound', async () => {
    const { manager } = createScriptManager();
    const both = buildRunCodeTool({ bridge: makeBridge(manager) });
    expect(both.description).toContain('## Agent capability');
    expect(both.description).toContain('agent.run(');
    expect(both.description).toContain('agent.start(');
    expect(both.description).toContain('continue_run_id` is rejected');

    const foregroundOnly = buildRunCodeTool({ bridge: makeBridge(manager), foregroundOnly: true });
    expect(foregroundOnly.description).toContain('agent.run(');
    expect(foregroundOnly.description).not.toContain('agent.start(');

    const bridgeWithoutAuthority = createRunCodeToolDefinition({
      loggingService: logging(),
      getToolRegistry: () => [echoTool()],
      getCwd: () => process.cwd(),
      approvalPolicyRegistry: new ToolApprovalPolicyRegistry(),
      agentSpecBridge: scriptBridge(makeBridge(manager)) as never,
    });
    expect(bridgeWithoutAuthority.description).not.toContain('## Agent capability');

    const authorityWithoutBridge = createRunCodeToolDefinition({
      loggingService: logging(),
      getToolRegistry: () => [echoTool()],
      getCwd: () => process.cwd(),
      approvalPolicyRegistry: new ToolApprovalPolicyRegistry(),
      agentSpecAuthority: authority(),
    });
    expect(authorityWithoutBridge.description).not.toContain('## Agent capability');

    const unbound = buildRunCodeTool({ withAuthority: false });
    expect(unbound.description).not.toContain('## Agent capability');
  });

  it('binds no agent global when the capability is absent', async () => {
    const definition = buildRunCodeTool({ withAuthority: false });
    const output = await execute(definition, 'return typeof agent;');
    expect(output).toContain('undefined');
  });
});
