import { it, expect } from 'vitest';
import { buildAgent } from './agent-factory.js';
import { clearModelCache, fetchModels } from '../services/model-service.js';
import { registerProvider, type ProviderDefinition } from '../providers/registry.js';
import type { AgentFactoryDeps } from './agent-factory.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { createEditorImpl } from './editor-impl.js';

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
      getAskUserAnswer: overrides.getAskUserAnswer ?? (() => undefined),
      checkToolInterceptors: overrides.checkToolInterceptors ?? (async () => null),
    },
  };
};

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
    createRunner: () => null as any,
    fetchModels: async () => [{ id: 'gpt-5.3-codex', default_reasoning_level: 'medium' }],
    capabilities: {
      supportsConversationChaining: true,
      supportsTracingControl: true,
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
