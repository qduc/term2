import { ApplicationRunLoop, type ApplicationAgent } from '../services/agent-runtime/application-run-loop.js';
import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnRequest,
} from '../contracts/streamed-model-turn.js';
import { it, expect } from 'vitest';
import { z } from 'zod';
import { buildAgent, buildAgentTools } from './agent-factory.js';
import { clearModelCache, fetchModels } from '../services/model-service.js';
import { registerProvider, type ProviderDefinition } from '../providers/registry.js';
import type { AgentFactoryDeps } from './agent-factory.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { createEditorImpl } from './editor-impl.js';
import type { ToolDefinition } from '../tools/types.js';
import { PostExecutePendingRegistry } from '../services/session/post-execute-pending-registry.js';
import { PostExecutePauseCapability } from '../services/session/post-execute-pause-capability.js';
import { createReadFileToolDefinition } from '../tools/file/read-file.js';

type MockLogger = ILoggingService & { debugCalls: any[][] };

const createMockLogger = (): MockLogger => {
  const debugCalls: any[][] = [];

  return {
    debugCalls,
    debug: (...args: any[]) => {
      debugCalls.push(args);
    },
    info: () => {},
    warn: () => {},
    error: () => {},
    security: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
    getCorrelationId: () => undefined,
    log: () => {},
  } as any;
};

const createMockSettings = (values: Record<string, any> = {}): ISettingsService => {
  const store: Record<string, any> = {
    'agent.model': 'gpt-4o',
    'agent.temperature': undefined,
    'agent.reasoningEffort': 'default',
    'agent.provider': 'openai',
    'agent.useFlexServiceTier': false,
    'agent.contextCompaction.enabled': false,
    'agent.contextCompaction.compactThreshold': 100_000,
    'shell.maxOutputChars': undefined,
    ...values,
  };

  return {
    get: <T>(key: string) => store[key] as T,
    set: (key: string, value: any) => {
      store[key] = value;
    },
  } as any;
};

const createDeps = (
  overrides: Partial<AgentFactoryDeps> & { settingsValues?: Record<string, any> } = {},
): { deps: AgentFactoryDeps; logger: MockLogger; settings: ISettingsService } => {
  const logger = createMockLogger();
  const settings = createMockSettings(overrides.settingsValues);
  const editor = createEditorImpl({
    loggingService: logger,
    settingsService: settings,
    executionContext: overrides.executionContext,
  });

  return {
    logger,
    settings,
    deps: {
      settings,
      logger,
      editor,
      providerId: overrides.providerId ?? 'openai',
      serviceTierOverrideForNextRequest: overrides.serviceTierOverrideForNextRequest ?? null,
      executionContext: overrides.executionContext,
      createMentor: overrides.createMentor ?? (async () => 'mentor-response'),
      runSubagent: overrides.runSubagent ?? (async () => ({ finalText: 'subagent-response' })),
      runSubagentAsync: overrides.runSubagentAsync ?? (async () => ({ runId: 'run-1', status: 'running' } as any)),
      getSubagentResult: overrides.getSubagentResult ?? (async () => ({ status: 'completed', finalText: '' } as any)),
      sendSubagentMessage:
        overrides.sendSubagentMessage ?? (() => ({ ok: true, runId: 'run-1', status: 'running', delivery: 'queued' })),
      cancelSubagentRun: overrides.cancelSubagentRun ?? (() => ({ ok: true, runId: 'run-1', status: 'cancelling' })),
      getAskUserAnswer: overrides.getAskUserAnswer ?? (() => undefined),
      checkToolInterceptors: overrides.checkToolInterceptors ?? (async () => null),
      postExecutePauseCapability: overrides.postExecutePauseCapability,
    },
  };
};

const postExecuteTestParameters = z.object({ value: z.string() });

const createToolDefinition = (
  overrides: Partial<ToolDefinition<typeof postExecuteTestParameters>> = {},
): ToolDefinition<typeof postExecuteTestParameters> => ({
  name: 'post_execute_test',
  description: 'Exercises the application-owned post-execute seam.',
  parameters: postExecuteTestParameters,
  needsApproval: () => false,
  execute: async ({ value }) => `original:${value}`,
  formatCommandMessage: () => [],
  ...overrides,
});

const buildTestTool = (definition: ToolDefinition<typeof postExecuteTestParameters>, deps: AgentFactoryDeps) =>
  buildAgentTools({
    toolDefinitions: [definition],
    resolvedModel: 'gpt-4o',
    shouldUseNativePatchTool: false,
    deps,
  })[0] as any;

it.sequential('post-execute policy can reject by returning the original result', async () => {
  const executions: string[] = [];
  let policyInput: unknown;
  const definition = createToolDefinition({
    execute: async ({ value }) => {
      executions.push(value);
      return `denied:${value}`;
    },
    postExecute: async ({ params, result, details }) => {
      policyInput = { params, result, callId: (details as any)?.toolCall?.callId };
      return result;
    },
  });
  const { deps } = createDeps();
  const tool = buildTestTool(definition, deps);

  const result = await tool.invoke({}, JSON.stringify({ value: 'no' }), { toolCall: { callId: 'call-reject' } });

  expect(result).toBe('denied:no');
  expect(executions).toEqual(['no']);
  expect(policyInput).toEqual({
    params: { value: 'no' },
    result: 'denied:no',
    callId: 'call-reject',
  });
});

it.sequential('post-execute policy re-executes without recursively invoking itself', async () => {
  const executions: string[] = [];
  let policyCalls = 0;
  const definition = createToolDefinition({
    execute: async ({ value }) => {
      executions.push(value);
      return `result-${executions.length}`;
    },
    postExecute: async ({ executeAgain }) => {
      policyCalls++;
      return executeAgain();
    },
  });
  const { deps } = createDeps();
  const tool = buildTestTool(definition, deps);

  const result = await tool.invoke({}, JSON.stringify({ value: 'again' }), { toolCall: { callId: 'call-again' } });

  expect(result).toBe('result-2');
  expect(executions).toEqual(['again', 'again']);
  expect(policyCalls).toBe(1);
});

it.sequential('tools without a post-execute policy return their ordinary result', async () => {
  const pending = new PostExecutePendingRegistry({ sessionId: 'session-a', epoch: 'epoch-a' });
  const capability = new PostExecutePauseCapability(pending);
  capability.setActiveRunId('run-a');
  const { deps } = createDeps({ postExecutePauseCapability: capability });
  const tool = buildTestTool(createToolDefinition(), deps);

  const result = await tool.invoke({}, JSON.stringify({ value: 'unchanged' }), { toolCall: { callId: 'call-plain' } });

  expect(result).toBe('original:unchanged');
  expect(pending.snapshot().entries).toEqual([]);
});

it.sequential('application run loop pauses an opted-in root tool pending approval', async () => {
  const callId = 'call-post-execute-pause';
  let requestCount = 0;
  let firstExecutionComplete!: () => void;
  const firstExecution = new Promise<void>((resolve) => {
    firstExecutionComplete = resolve;
  });
  const executionCallIds: Array<string | undefined> = [];
  const nextRequestResults: unknown[][] = [];
  const definition = createToolDefinition({
    execute: async (_params, _context, details) => {
      executionCallIds.push((details as any)?.toolCall?.callId);
      if (executionCallIds.length === 1) firstExecutionComplete();
      return executionCallIds.length === 1 ? 'denied result' : 'approved result';
    },
    postExecutePause: {
      describe: () => ({ toolName: 'post_execute_test', argumentsText: '{"value":"approved"}' }),
    },
  });
  const pending = new PostExecutePendingRegistry({ sessionId: 'session-a', epoch: 'epoch-a' });
  const capability = new PostExecutePauseCapability(pending);
  capability.setActiveRunId('run-a');
  const { deps } = createDeps({ postExecutePauseCapability: capability });
  const appOwnedTool = buildTestTool(definition, deps);
  // Production routes approval through the application coordinator. This test
  // isolates the post-execute seam after that gate has allowed the tool call.
  appOwnedTool.needsApproval = async () => false;
  const model: StreamedModelTurn = {
    async *stream(request: StreamedModelTurnRequest): AsyncIterable<StreamedModelTurnEvent> {
      requestCount++;
      if (requestCount === 2) {
        nextRequestResults.push(request.input.filter((item) => item.type === 'tool_result'));
      }
      if (requestCount === 1) {
        yield {
          type: 'tool_call',
          id: callId,
          name: definition.name,
          arguments: JSON.stringify({ value: 'approved' }),
        };
        yield {
          type: 'completion',
          responseId: `response-${requestCount}`,
          output: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        return;
      }
      yield {
        type: 'completion',
        responseId: `response-${requestCount}`,
        output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const agent: ApplicationAgent = {
    name: 'post-execute-pause-test',
    instructions: 'Use the tool.',
    model: 'scripted-model',
    tools: [appOwnedTool],
  };
  const loop = new ApplicationRunLoop({ resolveModel: async () => model });
  const stream = loop.startStream(agent, 'run the tool');
  const iteration = (async () => {
    for await (const _event of stream) {
      // Consume the native stream so the application run loop reaches the tool execution.
    }
  })();

  await firstExecution;
  expect(requestCount).toBe(1);

  await new Promise<void>((resolve) => setImmediate(resolve));
  const snapshot = pending.snapshot();
  expect(snapshot.entries).toMatchObject([{ runId: 'run-a', toolCallId: callId }]);
  expect(pending.decide({ revision: snapshot.revision, ids: [snapshot.entries[0]!.id], decision: 'approve' })).toEqual({
    kind: 'settled',
    settledIds: [snapshot.entries[0]!.id],
  });
  await iteration;
  await stream.completed;

  expect(executionCallIds).toEqual([callId, callId]);
  expect(nextRequestResults).toHaveLength(1);
  expect(nextRequestResults[0]).toHaveLength(1);
  expect((nextRequestResults[0][0] as any).output).toBe('approved result');
});

it.sequential('post-execute capability accepts a schema-typed definition through forTool', () => {
  const pending = new PostExecutePendingRegistry({ sessionId: 'session-a', epoch: 'epoch-a' });
  const capability = new PostExecutePauseCapability(pending);
  // read_file is the migrated proof tool: ToolDefinition<typeof schema>. The
  // seam must accept a schema-typed definition without an erasure cast.
  const policy = capability.forTool(createReadFileToolDefinition({}));
  expect(policy).toBeUndefined(); // read_file does not opt into post-execute pause
});

it.sequential('rejects a tool that ambiguously defines both post-execute mechanisms', () => {
  const { deps } = createDeps();
  expect(() =>
    buildTestTool(
      createToolDefinition({
        postExecute: ({ result }) => result,
        postExecutePause: { describe: () => ({ toolName: 'post_execute_test', argumentsText: '{}' }) },
      }),
      deps,
    ),
  ).toThrow('cannot define both postExecute and postExecutePause');
});

it.sequential('buildAgent creates Agent with correct model name', () => {
  const { deps } = createDeps({ settingsValues: { 'agent.model': 'gpt-4o-mini' } });

  const result = buildAgent({ model: 'gpt-4o-mini' }, deps);

  expect(result.agent.model).toBe('gpt-4o-mini');
  expect(result.resolvedModel).toBe('gpt-4o-mini');
});

it.sequential('buildAgent resolves model from settings when model param is omitted', () => {
  const { deps } = createDeps({ settingsValues: { 'agent.model': 'gpt-4.1-mini' } });

  const result = buildAgent({}, deps);

  expect(result.resolvedModel).toBe('gpt-4.1-mini');
  expect(result.agent.model).toBe('gpt-4.1-mini');
});

it.sequential('buildAgent returns resolvedModel', () => {
  const { deps } = createDeps();

  const result = buildAgent({ model: 'gpt-4o' }, deps);

  expect(result.resolvedModel).toBe('gpt-4o');
});

it.sequential('buildAgent applies strict tool schema when provider supports it', () => {
  const { deps } = createDeps({ providerId: 'openai', settingsValues: { 'agent.model': 'gpt-4o' } });

  const result = buildAgent({ model: 'gpt-4o' }, deps);
  const readFileTool = result.agent.tools.find((tool: any) => tool.name === 'read_file') as any;

  expect(readFileTool).toBeTruthy();
  expect(Array.isArray(readFileTool.parameters.required)).toBe(true);
  expect(readFileTool.parameters.required.includes('start_line')).toBe(true);
  expect(readFileTool.parameters.required.includes('end_line')).toBe(true);
});

it.sequential('buildAgent excludes custom apply_patch when native patch tool is enabled', () => {
  const { deps } = createDeps({ providerId: 'openai' });

  const result = buildAgent({ model: 'gpt-5.1' }, deps);
  const toolNames = result.agent.tools.map((tool: any) => tool.name);

  expect(toolNames.filter((name: string) => name === 'apply_patch').length).toBe(1);
  expect(toolNames.includes('apply_patch')).toBe(true);
});

it.sequential('buildAgent includes native applyPatchTool for supported models', () => {
  const { deps, logger } = createDeps({ providerId: 'openai' });

  const result = buildAgent({ model: 'gpt-5.1' }, deps);

  expect(result.agent.tools.some((tool: any) => tool.name === 'apply_patch')).toBe(true);
  expect(logger.debugCalls.some(([message]) => message === 'Using native applyPatchTool from SDK')).toBe(true);
});

it.sequential('native apply_patch needsApproval requires approval for paths outside the workspace', async () => {
  const { deps } = createDeps({ providerId: 'openai' });

  const result = buildAgent({ model: 'gpt-5.1' }, deps);
  const applyPatch = result.agent.tools.find((tool: any) => tool.name === 'apply_patch') as any;

  expect(applyPatch).toBeTruthy();
  expect(typeof applyPatch.needsApproval).toBe('function');

  // Path inside the workspace => no approval needed
  const insideResult = await applyPatch.needsApproval(undefined, {
    type: 'create_file',
    path: 'inside.txt',
    diff: '@@ -0,0 +1 @@\n+x',
  });
  expect(insideResult).toBe(false);

  // Path outside the workspace => approval required
  const outsideResult = await applyPatch.needsApproval(undefined, {
    type: 'create_file',
    path: '../outside.txt',
    diff: '@@ -0,0 +1 @@\n+x',
  });
  expect(outsideResult).toBe(true);
});

it.sequential('buildAgent resolves codex default_reasoning_level', async () => {
  clearModelCache();

  const fakeCodexProvider: ProviderDefinition = {
    id: 'codex',
    label: 'Mock Codex',
    createStreamedModel: () => null as any,
    fetchModels: async () => [{ id: 'gpt-5.3-codex', default_reasoning_level: 'medium' }],
    capabilities: {
      supportsConversationChaining: true,
    },
  };

  registerProvider(fakeCodexProvider, { allowOverride: true });

  const { deps } = createDeps({
    providerId: 'codex',
    settingsValues: {
      'agent.model': 'gpt-5.3-codex',
      'agent.reasoningEffort': 'default',
    },
  });

  await fetchModels(
    { settingsService: deps.settings, loggingService: deps.logger },
    'codex',
    async () =>
      ({
        ok: true,
        json: async () => ({ data: [] }),
      } as any),
  );

  const result = buildAgent({ model: 'gpt-5.3-codex' }, deps);
  const agent = result.agent as any;

  expect(result.resolvedModel).toBe('gpt-5.3-codex');
  expect(agent.modelSettings?.reasoning?.effort).toBe('medium');
  expect(agent.defaultRunOptions?.reasoning?.effort).toBe('medium');
});

it.sequential('buildAgent sets flex service tier when enabled', () => {
  const { deps } = createDeps({
    providerId: 'openai',
    settingsValues: {
      'agent.useFlexServiceTier': true,
    },
  });

  const result = buildAgent({ model: 'gpt-4o' }, deps);

  expect(result.agent.modelSettings?.providerData?.service_tier).toBe('flex');
});

it.sequential('buildAgent passes enabled context compaction to the OpenAI adapter', () => {
  const { deps } = createDeps({
    providerId: 'openai',
    settingsValues: {
      'agent.contextCompaction.enabled': true,
      'agent.contextCompaction.compactThreshold': 12_000,
    },
  });

  const result = buildAgent({ model: 'gpt-4o' }, deps);

  expect(result.agent.modelSettings?.providerData?.contextCompaction).toEqual({
    enabled: true,
    threshold: 12_000,
  });
});

it.sequential('buildAgent keeps context compaction out of non-OpenAI provider options', () => {
  const { deps } = createDeps({
    providerId: 'openrouter',
    settingsValues: {
      'agent.contextCompaction.enabled': true,
    },
  });

  const result = buildAgent({ model: 'gpt-4o' }, deps);

  expect(result.agent.modelSettings?.providerData?.contextCompaction).toBeUndefined();
});

it.sequential('buildAgent leaves parallel tool calls enabled by provider policy for Codex', () => {
  const { deps } = createDeps({
    providerId: 'codex',
    settingsValues: {
      'agent.model': 'gpt-5.4-mini',
    },
  });

  const result = buildAgent({ model: 'gpt-5.4-mini' }, deps);

  expect('parallelToolCalls' in (result.agent.modelSettings ?? {})).toBe(false);
});

it.sequential('buildAgent omits flex service tier when serviceTierOverrideForNextRequest is standard', () => {
  const { deps } = createDeps({
    providerId: 'openai',
    serviceTierOverrideForNextRequest: 'standard',
    settingsValues: {
      'agent.useFlexServiceTier': true,
    },
  });

  const result = buildAgent({ model: 'gpt-4o' }, deps);

  expect(result.agent.modelSettings?.providerData?.service_tier).toBeFalsy();
});

it.sequential('buildModelSettings omits reasoning when effort is default', () => {
  const { deps } = createDeps({
    providerId: 'openai',
    settingsValues: {
      'agent.reasoningEffort': 'default',
    },
  });

  const result = buildAgent({ model: 'gpt-4o', reasoningEffort: 'default' }, deps);

  expect(result.agent.modelSettings?.reasoning).toBeFalsy();
});
