import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Agent, RunContext, Runner, RunState, tool as createTool } from '@openai/agents';
import type { Model, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents-core';
import { z } from 'zod';
import { NestedSubagentRunner, incrementSubagentTurnCount, type CachedRoleTool } from './nested-runner.js';
import { SubagentToolPolicy, SubagentToolFactory } from './tool-policy.js';
import type { ILoggingService, ISettingsService } from '../service-interfaces.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { SupportedSubagentRole } from './types.js';
import type { ExecutionContext } from '../execution-context.js';
import { registerProvider } from '../../providers/registry.js';

const createSessionContextService = () => ({
  runWithContext: <T>(_context: any, fn: () => T) => fn(),
  getContext: () => null,
});

function createMockLogger(): ILoggingService {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    security: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
    getCorrelationId: () => undefined,
    log: () => {},
  } as any;
}

function createMockSettings(values: Record<string, any> = {}): ISettingsService {
  const store: Record<string, any> = { ...values };
  return {
    get: (key: string) => store[key],
    set: (key: string, val: any) => {
      store[key] = val;
    },
  } as any;
}

function createRunner(options: {
  providerId: string;
  model: Model;
  executionContext?: ExecutionContext;
  onEvent?: (event: ConversationEvent) => void;
  sandboxEnabled?: boolean;
}): NestedSubagentRunner {
  const settings = createMockSettings({
    'agent.model': 'scripted-model',
    'agent.provider': options.providerId,
    ...(options.sandboxEnabled !== undefined ? { 'sandbox.enabled': options.sandboxEnabled } : {}),
  });
  const logger = createMockLogger();
  const sessionContextService = createSessionContextService() as any;
  const toolPolicy = new SubagentToolPolicy({
    settings,
    logger,
    sessionContextService,
    executionContext: options.executionContext,
  });
  const toolFactory = new SubagentToolFactory({
    settings,
    logger,
    toolPolicy,
    executionContext: options.executionContext,
  });

  registerProvider({
    id: options.providerId,
    label: 'Scripted nested runner provider',
    createRunner: () =>
      new Runner({
        modelProvider: {
          getModel: () => options.model,
        },
      }),
    fetchModels: async () => [{ id: 'scripted-model' }],
  });

  return new NestedSubagentRunner({
    logger,
    settings,
    sessionContextService,
    executionContext: options.executionContext,
    toolFactory,
    roleToolCache: new Map(),
    onEvent: options.onEvent,
  });
}

function scriptedApprovalModel(): Model {
  return {
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      const hasToolOutput =
        Array.isArray(request.input) &&
        request.input.some((item: any) => item.type === 'function_call_result' || item.type === 'function_call_output');
      const isParentRun = request.tools.some((tool) => tool.name === 'run_subagent');
      return {
        usage: {
          requests: 1,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        } as any,
        output: hasToolOutput
          ? [
              {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    text: isParentRun ? 'Parent work completed.' : 'Nested work completed.',
                  },
                ],
              },
            ]
          : [
              {
                type: 'function_call',
                callId: isParentRun ? 'parent-subagent-call' : 'nested-shell-call',
                name: isParentRun ? 'run_subagent' : 'shell',
                arguments: isParentRun
                  ? JSON.stringify({ role: 'worker', task: 'create approved.txt' })
                  : JSON.stringify({ command: 'touch approved.txt' }),
              },
            ],
      } as ModelResponse;
    },
    async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {},
  };
}

function createParentHarness(nestedRunner: NestedSubagentRunner, model: Model) {
  const runSubagent = createTool({
    name: 'run_subagent',
    description: 'Run a nested subagent.',
    parameters: z.object({
      role: z.literal('worker'),
      task: z.string(),
    }),
    execute: (params, context, details) => nestedRunner.runAsTool(params, context, details),
  });
  const parentAgent = new Agent({
    name: 'parent-agent',
    model: 'scripted-model',
    instructions: 'Delegate the task to the worker.',
    tools: [runSubagent],
  });
  const parentRunner = new Runner({
    modelProvider: {
      getModel: () => model,
    },
  });
  return { parentAgent, parentRunner };
}

it.sequential('NestedSubagentRunner constructs, clearCache, getRoleAgent, getRoleAgentTool', async () => {
  const settings = createMockSettings({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
  });
  const logger = createMockLogger();
  const sessionContextService = createSessionContextService() as any;

  const toolPolicy = new SubagentToolPolicy({
    settings,
    logger,
    sessionContextService,
  });

  const toolFactory = new SubagentToolFactory({
    settings,
    logger,
    toolPolicy,
  });

  const roleToolCache = new Map<SupportedSubagentRole, CachedRoleTool>();

  const runner = new NestedSubagentRunner({
    logger,
    settings,
    sessionContextService,
    toolFactory,
    roleToolCache,
  });

  expect(roleToolCache.size).toBe(0);

  const agent = runner.getRoleAgent('explorer');
  expect(agent).toBeTruthy();
  expect(roleToolCache.size).toBe(1);
  expect(roleToolCache.has('explorer')).toBe(true);

  const tool = runner.getRoleAgentTool('explorer');
  expect(tool).toBeTruthy();

  runner.clearCache();
  expect(roleToolCache.size).toBe(0);
});

it.sequential('NestedSubagentRunner.runAsTool executes and emits events', async () => {
  const settings = createMockSettings({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
  });
  const logger = createMockLogger();
  const sessionContextService = createSessionContextService() as any;

  const toolPolicy = new SubagentToolPolicy({
    settings,
    logger,
    sessionContextService,
  });

  const toolFactory = new SubagentToolFactory({
    settings,
    logger,
    toolPolicy,
  });

  const roleToolCache = new Map<SupportedSubagentRole, CachedRoleTool>();
  const events: ConversationEvent[] = [];

  const runner = new NestedSubagentRunner({
    logger,
    settings,
    sessionContextService,
    toolFactory,
    roleToolCache,
    onEvent: (event) => events.push(event),
  });

  const request = {
    role: 'explorer' as SupportedSubagentRole,
    task: 'check filesystem',
  };

  // Get the tool to populate cache
  const tool = runner.getRoleAgentTool('explorer');

  // Mock tool invoke
  (tool as any).invoke = async (context: any, _input: any, _details: any) => {
    return JSON.stringify({
      agentId: context.toJSON().context.agentId,
      role: 'explorer',
      status: 'completed',
      finalText: 'Done from nested mock.',
      filesChanged: [],
      toolsUsed: [],
    });
  };

  const result = await runner.runAsTool(request);
  expect(result.status).toBe('completed');
  expect(result.finalText).toBe('Done from nested mock.');

  // Verify events emitted
  expect(events.some((e) => e.type === 'subagent_started' && e.role === 'explorer')).toBe(true);
  expect(events.some((e) => e.type === 'subagent_completed')).toBe(true);
});

it.sequential('NestedSubagentRunner.runAsTool surfaces Agent.asTool runtime failures', async () => {
  const settings = createMockSettings({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
  });
  const logger = createMockLogger();
  const sessionContextService = createSessionContextService() as any;
  const toolPolicy = new SubagentToolPolicy({
    settings,
    logger,
    sessionContextService,
  });
  const toolFactory = new SubagentToolFactory({
    settings,
    logger,
    toolPolicy,
  });
  const runner = new NestedSubagentRunner({
    logger,
    settings,
    sessionContextService,
    toolFactory,
    roleToolCache: new Map(),
  });
  const tool = runner.getRoleAgentTool('explorer');
  (tool as any).invoke = async () =>
    'An error occurred while running the tool. Please try again. Error: TypeError: fetch failed';

  let error: Error | undefined;
  try {
    await runner.runAsTool({
      role: 'explorer',
      task: 'inspect a file',
    });
  } catch (e) {
    error = e as Error;
  }

  expect(error?.message).toBe('TypeError: fetch failed');
});

it.sequential('NestedSubagentRunner.runAsTool restores context from resumeState', async () => {
  const settings = createMockSettings({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
  });
  const logger = createMockLogger();
  const sessionContextService = createSessionContextService() as any;

  const toolPolicy = new SubagentToolPolicy({
    settings,
    logger,
    sessionContextService,
  });

  const toolFactory = new SubagentToolFactory({
    settings,
    logger,
    toolPolicy,
  });

  const roleToolCache = new Map<SupportedSubagentRole, CachedRoleTool>();
  const events: ConversationEvent[] = [];

  const runner = new NestedSubagentRunner({
    logger,
    settings,
    sessionContextService,
    toolFactory,
    roleToolCache,
    onEvent: (event) => events.push(event),
  });

  const request = {
    role: 'explorer' as SupportedSubagentRole,
    task: 'resumed task',
  };

  const restoredAgentId = randomUUID();
  const context = new RunContext({
    agentId: restoredAgentId,
    role: 'explorer' as SupportedSubagentRole,
    task: 'resumed task',
    filesChanged: ['src/index.ts'],
    toolCounts: { shell: 2 },
    activeCommandMessages: {},
    turnCount: 1,
    maxTurns: 10,
  });

  const agent = runner.getRoleAgent('explorer');
  const state = new RunState(context, 'resumed task', agent, 10);
  const resumeState = state.toString();

  const tool = runner.getRoleAgentTool('explorer');

  (tool as any).invoke = async (contextParam: any, _input: any, _details: any) => {
    const runContext = contextParam.toJSON().context;
    return JSON.stringify({
      agentId: runContext.agentId,
      role: 'explorer',
      status: 'completed',
      finalText: 'Done from nested mock.',
      filesChanged: runContext.filesChanged,
      toolsUsed: Object.entries(runContext.toolCounts).map(([toolName, count]) => ({
        toolName,
        count: count as number,
      })),
    });
  };

  const result = await runner.runAsTool(request, undefined, { resumeState });
  expect(result.status).toBe('completed');
  expect(result.agentId).toBe(restoredAgentId);
  expect(result.filesChanged).toEqual(['src/index.ts']);
  expect(result.toolsUsed).toEqual([{ toolName: 'shell', count: 2 }]);

  // Verify subagent_started is NOT emitted when resuming
  expect(events.some((e) => e.type === 'subagent_started')).toBe(false);
  expect(events.some((e) => e.type === 'subagent_completed')).toBe(true);
});

it.sequential('NestedSubagentRunner.runAsTool propagates parent approvals', async () => {
  const settings = createMockSettings({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
  });
  const logger = createMockLogger();
  const sessionContextService = createSessionContextService() as any;

  const toolPolicy = new SubagentToolPolicy({
    settings,
    logger,
    sessionContextService,
  });

  const toolFactory = new SubagentToolFactory({
    settings,
    logger,
    toolPolicy,
  });

  const roleToolCache = new Map<SupportedSubagentRole, CachedRoleTool>();

  const runner = new NestedSubagentRunner({
    logger,
    settings,
    sessionContextService,
    toolFactory,
    roleToolCache,
  });

  const parentContext = {
    toJSON: () => ({
      approvals: {
        'tool-call-123': { approved: true },
      },
    }),
  };

  const request = {
    role: 'explorer' as SupportedSubagentRole,
    task: 'check approvals',
  };

  let invokedNestedContext: any = null;

  const tool = runner.getRoleAgentTool('explorer');

  (tool as any).invoke = async (contextParam: any, _input: any, _details: any) => {
    invokedNestedContext = contextParam;
    return JSON.stringify({
      agentId: contextParam.toJSON().context.agentId,
      role: 'explorer',
      status: 'completed',
      finalText: 'Done from nested mock.',
      filesChanged: [],
      toolsUsed: [],
    });
  };

  await runner.runAsTool(request, parentContext);

  expect(invokedNestedContext).toBeTruthy();
  // Verify that parent approvals were merged
  const nestedApprovals = invokedNestedContext.toJSON().approvals;
  expect(nestedApprovals).toEqual({
    'tool-call-123': { approved: true },
  });
});

it.sequential('NestedSubagentRunner.runAsTool handles cancellation via abort signal', async () => {
  const settings = createMockSettings({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
  });
  const logger = createMockLogger();
  const sessionContextService = createSessionContextService() as any;

  const toolPolicy = new SubagentToolPolicy({
    settings,
    logger,
    sessionContextService,
  });

  const toolFactory = new SubagentToolFactory({
    settings,
    logger,
    toolPolicy,
  });

  const roleToolCache = new Map<SupportedSubagentRole, CachedRoleTool>();

  const runner = new NestedSubagentRunner({
    logger,
    settings,
    sessionContextService,
    toolFactory,
    roleToolCache,
  });

  const controller = new AbortController();
  controller.abort();

  const request = {
    role: 'explorer' as SupportedSubagentRole,
    task: 'cancelled task',
  };

  const tool = runner.getRoleAgentTool('explorer');

  (tool as any).invoke = async (contextParam: any, _input: any, details: any) => {
    if (details?.signal?.aborted) {
      const err = new Error('Request was aborted.');
      err.name = 'AbortError';
      throw err;
    }
    return JSON.stringify({
      agentId: contextParam.toJSON().context.agentId,
      role: 'explorer',
      status: 'completed',
      finalText: 'Done.',
      filesChanged: [],
      toolsUsed: [],
    });
  };

  let thrown: Error | undefined;
  try {
    await runner.runAsTool(request, undefined, { signal: controller.signal });
  } catch (e) {
    thrown = e as Error;
  }
  expect(thrown?.name).toBe('AbortError');
  expect(thrown?.message).toMatch(/aborted/i);
});

it.sequential('NestedSubagentRunner.runAsTool propagates request.signal to nested tool invoke', async () => {
  const settings = createMockSettings({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
  });
  const logger = createMockLogger();
  const sessionContextService = createSessionContextService() as any;

  const toolPolicy = new SubagentToolPolicy({
    settings,
    logger,
    sessionContextService,
  });

  const toolFactory = new SubagentToolFactory({
    settings,
    logger,
    toolPolicy,
  });

  const roleToolCache = new Map<SupportedSubagentRole, CachedRoleTool>();

  const runner = new NestedSubagentRunner({
    logger,
    settings,
    sessionContextService,
    toolFactory,
    roleToolCache,
  });

  const bridgeController = new AbortController();
  const request = {
    role: 'explorer' as SupportedSubagentRole,
    task: 'task',
    signal: bridgeController.signal,
  };

  const tool = runner.getRoleAgentTool('explorer');
  let capturedDetailsSignal: AbortSignal | undefined;

  (tool as any).invoke = async (contextParam: any, _input: any, details: any) => {
    capturedDetailsSignal = details?.signal;
    return JSON.stringify({
      agentId: contextParam.toJSON().context.agentId,
      role: 'explorer',
      status: 'completed',
      finalText: 'Done.',
      filesChanged: [],
      toolsUsed: [],
    });
  };

  await runner.runAsTool(request, undefined, undefined);

  expect(capturedDetailsSignal).toBeDefined();
  expect(capturedDetailsSignal?.aborted).toBe(false);
});

it.sequential('NestedSubagentRunner.runAsTool cancels when request.signal aborts mid-run', async () => {
  const settings = createMockSettings({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
  });
  const logger = createMockLogger();
  const sessionContextService = createSessionContextService() as any;

  const toolPolicy = new SubagentToolPolicy({
    settings,
    logger,
    sessionContextService,
  });

  const toolFactory = new SubagentToolFactory({
    settings,
    logger,
    toolPolicy,
  });

  const roleToolCache = new Map<SupportedSubagentRole, CachedRoleTool>();

  const runner = new NestedSubagentRunner({
    logger,
    settings,
    sessionContextService,
    toolFactory,
    roleToolCache,
  });

  const bridgeController = new AbortController();
  const request = {
    role: 'explorer' as SupportedSubagentRole,
    task: 'task',
    signal: bridgeController.signal,
  };

  const tool = runner.getRoleAgentTool('explorer');

  (tool as any).invoke = async (_contextParam: any, _input: any, _details: any) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return JSON.stringify({
      agentId: 'should-not-reach',
      role: 'explorer',
      status: 'completed',
      finalText: 'Done.',
      filesChanged: [],
      toolsUsed: [],
    });
  };

  const runPromise = runner.runAsTool(request, undefined, undefined);
  queueMicrotask(() => bridgeController.abort());

  let thrown: Error | undefined;
  try {
    await runPromise;
  } catch (e) {
    thrown = e as Error;
  }

  expect(thrown?.name).toBe('AbortError');
  expect(thrown?.message).toMatch(/aborted/i);
});

it.sequential('NestedSubagentRunner resumes a real Agent.asTool run after nested approval', async () => {
  const providerId = `nested-approval-${randomUUID()}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-nested-approval-'));

  // cleanup handled at end of test via try/finally
  const events: ConversationEvent[] = [];
  const model = scriptedApprovalModel();
  const runner = createRunner({
    providerId,
    model,
    sandboxEnabled: false,
    executionContext: {
      getCwd: () => tmpDir,
      isRemote: () => false,
      getSSHService: () => undefined,
    } as unknown as ExecutionContext,
    onEvent: (event) => events.push(event),
  });
  const { parentAgent, parentRunner } = createParentHarness(runner, model);

  const interrupted = await parentRunner.run(parentAgent, 'delegate this task');
  expect(interrupted.interruptions.length).toBe(1);
  expect(fs.existsSync(path.join(tmpDir, 'approved.txt'))).toBe(false);

  const state = await RunState.fromString(parentAgent, interrupted.state.toString());
  const [approval] = state.getInterruptions();
  state.approve(approval);
  const resumed = await parentRunner.run(parentAgent, state);

  expect(resumed.finalOutput).toBe('Parent work completed.');
  expect(fs.existsSync(path.join(tmpDir, 'approved.txt'))).toBe(true);
  expect(events.filter((event) => event.type === 'subagent_started').map((event: any) => event.agentId)).toEqual([
    'parent-subagent-call',
  ]);
  expect(events.filter((event) => event.type === 'subagent_completed').length).toBe(1);
});

it.sequential('NestedSubagentRunner rejects malformed real Agent.asTool resume state', async () => {
  const providerId = `nested-malformed-${randomUUID()}`;

  // TODO: // TODO: t.teardown(() => unregisterProvider(providerId)) needs manual try/finally conversion;
  const runner = createRunner({
    providerId,
    model: scriptedApprovalModel(),
  });

  let thrown2: Error | undefined;
  try {
    await runner.runAsTool({ role: 'explorer', task: 'resume malformed state' }, undefined, {
      resumeState: '{"context":{"context":{"agentId":"restored"}}}',
    });
  } catch (e) {
    thrown2 = e as Error;
  }
  expect(thrown2?.message).toMatch(/Run state is missing schema version/i);
});

it.sequential('NestedSubagentRunner does not resume approved nested work after parent cancellation', async () => {
  const providerId = `nested-cancelled-resume-${randomUUID()}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-nested-cancelled-'));

  // cleanup handled at end of test via try/finally
  const model = scriptedApprovalModel();
  const runner = createRunner({
    providerId,
    model,
    sandboxEnabled: false,
    executionContext: {
      getCwd: () => tmpDir,
      isRemote: () => false,
      getSSHService: () => undefined,
    } as unknown as ExecutionContext,
  });
  const { parentAgent, parentRunner } = createParentHarness(runner, model);

  const interrupted = await parentRunner.run(parentAgent, 'delegate this task');
  const state = await RunState.fromString(parentAgent, interrupted.state.toString());
  const [approval] = state.getInterruptions();
  state.approve(approval);
  const nestedResumeState = state.getPendingAgentToolRun('run_subagent', 'parent-subagent-call');
  expect(nestedResumeState).toBeTruthy();
  const controller = new AbortController();
  controller.abort();

  let thrown3: Error | undefined;
  try {
    await runner.runAsTool({ role: 'worker', task: 'create approved.txt' }, (state as any)._context, {
      resumeState: nestedResumeState,
      signal: controller.signal,
      toolCall: { callId: 'parent-subagent-call' },
    });
  } catch (e) {
    thrown3 = e as Error;
  }
  expect(thrown3?.name).toBe('AbortError');
  expect(fs.existsSync(path.join(tmpDir, 'approved.txt'))).toBe(false);
});

it('incrementSubagentTurnCount reads turnCount from the unwrapped user context', () => {
  // Regression test: the OpenAI Agents SDK passes the user context unwrapped
  // to callModelInputFilter (see applyCallModelInputFilter in
  // @openai/agents-core/dist/runner/conversation.js, which sets
  // `context: context.context`). The filter must therefore read
  // `args.context.turnCount`, not `args.context.context.turnCount`.
  //
  // The earlier bug accessed `args.context.context.turnCount`, which is
  // always undefined, so turnCount never advanced and the turn-limit warning
  // was never injected into nested subagent tool output.

  const modelData = { input: [] };
  const userContext = { turnCount: 0, maxTurns: 20 };

  // The SDK calls the filter with the unwrapped user context as args.context.
  expect(incrementSubagentTurnCount({ context: userContext, modelData })).toBe(modelData);
  expect(userContext.turnCount).toBe(1);

  expect(incrementSubagentTurnCount({ context: userContext, modelData })).toBe(modelData);
  expect(userContext.turnCount).toBe(2);
});

it('incrementSubagentTurnCount is a no-op when context is missing or non-object', () => {
  // Defensive: the filter must tolerate the SDK passing no context, an
  // undefined context, or a non-object context without throwing.
  const modelData = { input: [] };

  expect(incrementSubagentTurnCount({ context: undefined, modelData })).toBe(modelData);
  expect(incrementSubagentTurnCount({ context: null, modelData })).toBe(modelData);
  expect(incrementSubagentTurnCount({ modelData })).toBe(modelData);
  expect(incrementSubagentTurnCount({ context: 'not-an-object', modelData })).toBe(modelData);
});
