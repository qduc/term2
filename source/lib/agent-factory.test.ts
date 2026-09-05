import { ApplicationRunLoop, type ApplicationAgent } from '../services/agent-runtime/application-run-loop.js';
import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnRequest,
} from '../contracts/streamed-model-turn.js';
import { it, expect } from 'vitest';
import { z } from 'zod';
import path from 'path';
import { SANDBOX_TEMP_DIR } from '../utils/shell/temp-dir.js';
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
import { createApplyPatchToolDefinition } from '../tools/file/apply-patch.js';
import { BackgroundShellRegistry } from '../services/shell/background-shell-registry.js';
import { getAgentDefinition } from '../agent.js';
import { isDirectlyCallable, RUN_CODE_PROHIBITED_TOOLS } from '../tools/system/run-code/run-code.js';
import { ToolApprovalPolicyRegistry } from '../services/approval/tool-approval-policy-registry.js';

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
    'agent.contextCompaction.compactThreshold': 0.8,
    'shell.maxOutputChars': undefined,
    ...values,
  };

  return {
    get: <T>(key: string) => store[key] as T,
    // getDynamic is part of ISettingsService and is now read unconditionally
    // by the tool-capability mask in getAgentDefinition.
    getDynamic: (key: string) => store[key],
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
      approvalPolicyRegistry: overrides.approvalPolicyRegistry ?? new ToolApprovalPolicyRegistry(),
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
      backgroundShellRegistry: overrides.backgroundShellRegistry,
      allowBackgroundShell: overrides.allowBackgroundShell,
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
  canRequireApproval: true,
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

it.sequential('keeps every registered tool reachable across direct and script paths', async () => {
  const { deps } = createDeps({ settingsValues: { 'app.searchViaShell': 'off' } });
  const raw = getAgentDefinition(
    {
      settingsService: deps.settings,
      loggingService: deps.logger,
    },
    'gpt-4o',
  );
  const built = buildAgentTools({
    toolDefinitions: raw.tools,
    resolvedModel: 'gpt-4o',
    shouldUseNativePatchTool: false,
    deps,
  });
  const runCode = built.find((tool) => tool.name === 'run_code');
  expect(runCode).toBeDefined();

  const rendered = String(
    await runCode!.execute({ code: 'return Object.keys(tools).sort().join("|");', timeout_ms: 60_000 } as never),
  );
  const exposed =
    rendered
      .match(/Result:\n([^\n]*)/)?.[1]
      ?.split('|')
      .filter(Boolean) ?? [];
  const direct = built.map((tool) => tool.name);
  const rawNames = raw.tools.map((tool) => tool.name);
  const exposedToolNames = exposed.filter((name) => name !== 'describe');

  expect(runCode!.description).toContain('Other tools (names only; schemas are available on demand)');
  expect(new Set([...direct, ...exposedToolNames])).toEqual(new Set(rawNames));
  expect(new Set(direct.filter((name) => exposedToolNames.includes(name)))).toEqual(
    new Set(raw.tools.filter((tool) => tool.canRequireApproval === true).map((tool) => tool.name)),
  );
  for (const tool of raw.tools) {
    expect(direct.includes(tool.name)).toBe(isDirectlyCallable(tool));
    expect(exposedToolNames.includes(tool.name)).toBe(!RUN_CODE_PROHIBITED_TOOLS.has(tool.name));
  }
});

it.sequential('keeps the complete wrapped registry when run_code is unavailable', () => {
  const { deps } = createDeps({
    settingsValues: { 'tools.shell.enabled': false, 'app.searchViaShell': 'off' },
  });
  const raw = getAgentDefinition(
    {
      settingsService: deps.settings,
      loggingService: deps.logger,
    },
    'gpt-4o',
  );

  expect(raw.tools.map((tool) => tool.name)).toContain('web_search');
  expect(raw.tools.map((tool) => tool.name)).not.toContain('run_code');

  const built = buildAgentTools({
    toolDefinitions: raw.tools,
    resolvedModel: 'gpt-4o',
    shouldUseNativePatchTool: false,
    deps,
  });

  expect(built.map((tool) => tool.name)).toEqual(raw.tools.map((tool) => tool.name));
});

it.sequential('requires non-constant approval predicates to declare a direct fallback', () => {
  const { deps } = createDeps({ settingsValues: { 'app.searchViaShell': 'off' } });
  const raw = getAgentDefinition(
    {
      settingsService: deps.settings,
      loggingService: deps.logger,
    },
    'gpt-4o',
  );

  for (const tool of raw.tools) {
    const compactPredicate = Function.prototype.toString.call(tool.needsApproval).replace(/\s/g, '').replace(/;$/, '');
    const isConstantPredicate = compactPredicate.endsWith('=>false') || compactPredicate.endsWith('=>true');
    if (!isConstantPredicate && !RUN_CODE_PROHIBITED_TOOLS.has(tool.name)) {
      expect(tool.canRequireApproval, `${tool.name} needs an explicit approval fallback`).toBe(true);
    }
  }
});

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

it.sequential('preserves self-bounded serialized tool output unchanged', async () => {
  const serialized = JSON.stringify({ text: 'first\nsecond', charsUsed: 42 });
  const definition = createToolDefinition({
    preserveSerializedOutput: true,
    execute: async () => serialized,
  });
  const { deps } = createDeps({ settingsValues: { 'shell.maxOutputChars': 10 } });
  const tool = buildTestTool(definition, deps);

  expect(await tool.invoke({}, JSON.stringify({ value: 'ignored' }))).toBe(serialized);
});

it.sequential('preserves multimodal content-part tool results instead of coercing them to a string', async () => {
  // read_file returns a content-part array for images. Coercing it via
  // String() flattens it to "[object Object],[object Object]", destroying the
  // image part before the provider converter can deliver it. Trimming it would
  // truncate the base64 data.
  const longData = Buffer.from('x'.repeat(10_000)).toString('base64');
  const imageParts = [
    { type: 'text', text: 'Image: logo.png (1234 bytes, image/png)' },
    { type: 'image', image: { data: longData, mediaType: 'image/png' } },
  ];
  const definition = createToolDefinition({
    execute: async () => imageParts,
  });
  const { deps } = createDeps({ settingsValues: { 'shell.maxOutputChars': 50 } });
  const tool = buildTestTool(definition, deps);

  const result = await tool.invoke({}, JSON.stringify({ value: 'ignored' }), { toolCall: { callId: 'call-image' } });

  expect(Array.isArray(result)).toBe(true);
  expect(result).toEqual(imageParts);
});

it.sequential('buildAgent keeps root background shell controls reachable through run_code', () => {
  const registry = new BackgroundShellRegistry<any>();
  const { deps } = createDeps({ backgroundShellRegistry: registry });

  const { agent } = buildAgent({}, deps);

  expect(agent.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(['shell', 'run_code']));
  expect(agent.tools?.map((tool) => tool.name)).not.toContain('get_shell_job');
  expect(agent.tools?.map((tool) => tool.name)).not.toContain('cancel_shell_job');
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

it.sequential('YOLO bypasses root post-execute permission pauses', async () => {
  const pending = new PostExecutePendingRegistry({ sessionId: 'session-yolo', epoch: 'epoch-yolo' });
  const capability = new PostExecutePauseCapability(pending);
  capability.setActiveRunId('run-yolo');
  const { deps } = createDeps({
    settingsValues: { 'shell.autoApproveMode': 'always' },
    postExecutePauseCapability: capability,
  });
  const tool = buildTestTool(
    createToolDefinition({
      postExecutePause: {
        describe: () => ({ toolName: 'post_execute_test', argumentsText: '{}' }),
      },
    }),
    deps,
  );

  const result = await Promise.race([
    tool.invoke({}, JSON.stringify({ value: 'yolo' }), { toolCall: { callId: 'call-yolo' } }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('YOLO tool invocation remained blocked by a post-execute permission gate')),
        100,
      ),
    ),
  ]);
  expect(result).toBe('original:yolo');
  expect(pending.snapshot().entries).toEqual([]);
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

it.sequential('buildAgent advertises apply_patch as patch-only to strict-schema providers', () => {
  const { deps, logger, settings } = createDeps({ providerId: 'openai' });
  const applyPatch = createApplyPatchToolDefinition({ loggingService: logger, settingsService: settings });

  const tool = buildAgentTools({
    toolDefinitions: [applyPatch],
    resolvedModel: 'gpt-4o',
    shouldUseNativePatchTool: false,
    deps,
  })[0] as any;

  expect(tool.parameters.required).toEqual(['patch']);
  expect(Object.keys(tool.parameters.properties)).toEqual(['patch']);
  expect(Object.keys(tool.parameters.properties.patch)).toContain('type');
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

  const applyPatch = result.agent.tools.find((tool: any) => tool.name === 'apply_patch') as any;
  expect(applyPatch).toBeTruthy();
  expect(applyPatch.modelTool).toMatchObject({ type: 'custom', format: { type: 'grammar', syntax: 'lark' } });
  expect(applyPatch.modelTool.format.definition).toContain('start: begin_patch hunk+ end_patch');
  expect(applyPatch.parseModelArguments('*** Begin Patch\n*** Delete File: old.txt\n*** End Patch')).toEqual({
    operations: [{ type: 'delete_file', path: 'old.txt', diff: '' }],
  });
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

  // Path in SANDBOX_TEMP_DIR => auto-approved without approval prompt
  const tempResult = await applyPatch.needsApproval(undefined, {
    type: 'create_file',
    path: path.join(SANDBOX_TEMP_DIR, 'native-patch-temp.txt'),
    diff: '@@ -0,0 +1 @@\n+x',
  });
  expect(tempResult).toBe(false);
});

it.sequential('registers the final native apply_patch policy for nested consumers', async () => {
  const { deps } = createDeps({ providerId: 'openai' });

  buildAgent({ model: 'gpt-5.1' }, deps);

  await expect(
    deps.approvalPolicyRegistry.evaluate({
      toolName: 'apply_patch',
      args: { type: 'create_file', path: 'inside.txt', diff: '' },
    }),
  ).resolves.toEqual({ kind: 'auto_approve' });
  await expect(
    deps.approvalPolicyRegistry.evaluate({
      toolName: 'apply_patch',
      args: { type: 'delete_file', path: 'inside.txt', diff: '' },
    }),
  ).resolves.toEqual({ kind: 'prompt' });
});

it.sequential('keeps approval policies isolated between coexisting tool graphs', async () => {
  const createPolicyTool = (requiresApproval: boolean): ToolDefinition<any> => ({
    name: 'graph_policy_test',
    description: 'graph policy test',
    parameters: z.object({}),
    canRequireApproval: true,
    needsApproval: () => requiresApproval,
    execute: async () => 'ok',
    formatCommandMessage: () => [],
  });
  const first = createDeps({ approvalPolicyRegistry: new ToolApprovalPolicyRegistry() });
  const second = createDeps({ approvalPolicyRegistry: new ToolApprovalPolicyRegistry() });

  buildAgentTools({
    toolDefinitions: [createPolicyTool(false)],
    resolvedModel: 'gpt-4o',
    shouldUseNativePatchTool: false,
    deps: first.deps,
  });
  buildAgentTools({
    toolDefinitions: [createPolicyTool(true)],
    resolvedModel: 'gpt-4o',
    shouldUseNativePatchTool: false,
    deps: second.deps,
  });

  await expect(
    first.deps.approvalPolicyRegistry.evaluate({ toolName: 'graph_policy_test', args: {} }),
  ).resolves.toEqual({
    kind: 'auto_approve',
  });
  await expect(
    second.deps.approvalPolicyRegistry.evaluate({ toolName: 'graph_policy_test', args: {} }),
  ).resolves.toEqual({
    kind: 'prompt',
  });
});

it.sequential('YOLO bypasses native apply_patch approval for paths outside the workspace', async () => {
  const { deps } = createDeps({ providerId: 'openai', settingsValues: { 'shell.autoApproveMode': 'always' } });

  const result = buildAgent({ model: 'gpt-5.1' }, deps);
  const applyPatch = result.agent.tools.find((tool: any) => tool.name === 'apply_patch') as any;

  expect(applyPatch).toBeTruthy();
  await expect(
    applyPatch.needsApproval(undefined, {
      type: 'create_file',
      path: '../outside.txt',
      diff: '@@ -0,0 +1 @@\n+x',
    }),
  ).resolves.toBe(false);
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

it.sequential('buildAgent sends high effort for neuralwatt when the setting is default', () => {
  const { deps } = createDeps({
    providerId: 'neuralwatt',
    settingsValues: {
      'agent.model': 'deepseek-v4-flash',
      'agent.reasoningEffort': 'default',
    },
  });

  const result = buildAgent({ model: 'deepseek-v4-flash', reasoningEffort: 'default' }, deps);
  const agent = result.agent as any;

  expect(agent.modelSettings?.reasoning?.effort).toBe('high');
  expect(agent.defaultRunOptions?.reasoning?.effort).toBe('high');
});

it.sequential('buildAgent matches the neuralwatt provider id case-insensitively', () => {
  const { deps } = createDeps({
    providerId: 'Neuralwatt',
    settingsValues: {
      'agent.model': 'deepseek-v4-flash',
      'agent.reasoningEffort': 'default',
    },
  });

  const result = buildAgent({ model: 'deepseek-v4-flash', reasoningEffort: 'default' }, deps);

  expect(result.agent.modelSettings?.reasoning?.effort).toBe('high');
});

it.sequential('buildAgent leaves an explicit neuralwatt effort alone', () => {
  const { deps } = createDeps({
    providerId: 'neuralwatt',
    settingsValues: {
      'agent.model': 'deepseek-v4-flash',
      'agent.reasoningEffort': 'low',
    },
  });

  const result = buildAgent({ model: 'deepseek-v4-flash', reasoningEffort: 'low' }, deps);

  expect(result.agent.modelSettings?.reasoning?.effort).toBe('low');
});

it.sequential('buildAgent honours an explicit neuralwatt effort of none', () => {
  const { deps } = createDeps({
    providerId: 'neuralwatt',
    settingsValues: {
      'agent.model': 'deepseek-v4-flash',
      'agent.reasoningEffort': 'none',
    },
  });

  const result = buildAgent({ model: 'deepseek-v4-flash', reasoningEffort: 'none' }, deps);

  expect(result.agent.modelSettings?.reasoning?.effort).toBe('none');
});

it.sequential('buildAgent still omits reasoning for providers with no default level', () => {
  const { deps } = createDeps({
    providerId: 'openai-compatible',
    settingsValues: {
      'agent.model': 'some-local-model',
      'agent.reasoningEffort': 'default',
    },
  });

  const result = buildAgent({ model: 'some-local-model', reasoningEffort: 'default' }, deps);

  expect(result.agent.modelSettings?.reasoning).toBeFalsy();
  expect((result.agent as any).defaultRunOptions).toBeUndefined();
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
      'agent.contextCompaction.compactThreshold': 0.5,
    },
  });

  const result = buildAgent({ model: 'gpt-4o' }, deps);

  expect(result.agent.modelSettings?.providerData?.contextCompaction).toEqual({
    enabled: true,
    threshold: 0.5,
  });
});

it.sequential('buildAgent passes an optional raw context compaction threshold without changing ratio-only data', () => {
  const { deps } = createDeps({
    providerId: 'openai',
    settingsValues: {
      'agent.contextCompaction.enabled': true,
      'agent.contextCompaction.mode': 'auto',
      'agent.contextCompaction.compactThreshold': 0.8,
      'agent.contextCompaction.compactThresholdTokens': 120_000,
    },
  });
  const result = buildAgent({ model: 'gpt-5.4-nano' }, deps);
  expect(result.agent.modelSettings?.providerData?.contextCompaction).toEqual({
    enabled: true,
    threshold: 0.8,
    thresholdTokens: 120_000,
  });
});

it.sequential('buildAgent keeps context_management out of the Codex adapter', () => {
  registerProvider(
    {
      id: 'codex',
      label: 'Codex',
      createStreamedModel: () => null as any,
      fetchModels: async () => [],
      capabilities: {
        supportsConversationChaining: true,
        supportsContextCompaction: false,
      },
    },
    { allowOverride: true },
  );

  const { deps } = createDeps({
    providerId: 'codex',
    settingsValues: {
      'agent.contextCompaction.enabled': true,
      'agent.contextCompaction.compactThreshold': 0.5,
    },
  });

  const result = buildAgent({ model: 'gpt-5.3-codex-spark' }, deps);

  expect(result.agent.modelSettings?.providerData?.contextCompaction).toBeUndefined();
});

it.sequential('buildAgent keeps context compaction out of providers without the capability', () => {
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

it.sequential('buildModelSettings forwards generation safety limits', () => {
  const { deps } = createDeps({
    providerId: 'codex',
    settingsValues: {
      'agent.maxOutputTokens': 12_345,
      'agent.maxStreamOutputChars': 45_678,
      'agent.maxModelRequestDurationMs': 67_890,
    },
  });

  const result = buildAgent({ model: 'gpt-5.6-luna' }, deps);

  expect(result.agent.modelSettings).toMatchObject({
    maxTokens: 12_345,
    maxStreamOutputChars: 45_678,
    maxModelRequestDurationMs: 67_890,
  });
});

it.sequential('buildModelSettings clamps the configured token cap to the model catalog limit', () => {
  const { deps } = createDeps({
    providerId: 'openai',
    settingsValues: { 'agent.maxOutputTokens': 32_000 },
  });

  const result = buildAgent({ model: 'gpt-4o' }, deps);

  expect(result.agent.modelSettings?.maxTokens).toBe(16_384);
});

it.sequential('root tools reject arguments that do not match the schema instead of executing', async () => {
  // Regression: a provider response carrying empty tool arguments reached the
  // executor, which dereferenced a missing required field and returned a raw
  // TypeError ("Cannot read properties of undefined (reading 'startsWith')")
  // that the model could not act on. Subagent tools were already guarded.
  const executions: unknown[] = [];
  const definition = createToolDefinition({
    execute: async (params) => {
      executions.push(params);
      return 'executed';
    },
  });
  const { deps } = createDeps();
  const tool = buildTestTool(definition, deps);

  const result = await tool.invoke({}, JSON.stringify({}), { toolCall: { callId: 'call-empty-args' } });

  expect(executions).toEqual([]);
  expect(String(result)).toContain('did not match schema for post_execute_test');
  expect(String(result)).toContain('value');
});

it.sequential('root tools still execute when arguments match the schema', async () => {
  const definition = createToolDefinition();
  const { deps } = createDeps();
  const tool = buildTestTool(definition, deps);

  const result = await tool.invoke({}, JSON.stringify({ value: 'ok' }), { toolCall: { callId: 'call-valid' } });

  expect(result).toBe('original:ok');
});
