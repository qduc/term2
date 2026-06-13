import test from 'ava';
import { buildAgent } from './agent-factory.js';
import { clearModelCache, fetchModels } from '../services/model-service.js';
import { getProvider, registerProvider, unregisterProvider, type ProviderDefinition } from '../providers/registry.js';
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

const originalCodexProvider = getProvider('codex');

test.serial('buildAgent creates Agent with correct model name', (t) => {
  const { deps } = createDeps({ settingsValues: { 'agent.model': 'gpt-4o-mini' } });

  const result = buildAgent({ model: 'gpt-4o-mini' }, deps);

  t.is(result.agent.model, 'gpt-4o-mini');
  t.is(result.resolvedModel, 'gpt-4o-mini');
});

test.serial('buildAgent resolves model from settings when model param is omitted', (t) => {
  const { deps } = createDeps({ settingsValues: { 'agent.model': 'gpt-4.1-mini' } });

  const result = buildAgent({}, deps);

  t.is(result.resolvedModel, 'gpt-4.1-mini');
  t.is(result.agent.model, 'gpt-4.1-mini');
});

test.serial('buildAgent returns resolvedModel', (t) => {
  const { deps } = createDeps();

  const result = buildAgent({ model: 'gpt-4o' }, deps);

  t.is(result.resolvedModel, 'gpt-4o');
});

test.serial('buildAgent applies strict tool schema when provider supports it', (t) => {
  const { deps } = createDeps({ providerId: 'openai', settingsValues: { 'agent.model': 'gpt-4o' } });

  const result = buildAgent({ model: 'gpt-4o' }, deps);
  const readFileTool = result.agent.tools.find((tool: any) => tool.name === 'read_file') as any;

  t.truthy(readFileTool);
  t.true(Array.isArray(readFileTool.parameters.required));
  t.true(readFileTool.parameters.required.includes('start_line'));
  t.true(readFileTool.parameters.required.includes('end_line'));
});

test.serial('buildAgent excludes custom apply_patch when native patch tool is enabled', (t) => {
  const { deps } = createDeps({ providerId: 'openai' });

  const result = buildAgent({ model: 'gpt-5.1' }, deps);
  const toolNames = result.agent.tools.map((tool: any) => tool.name);

  t.is(toolNames.filter((name: string) => name === 'apply_patch').length, 1);
  t.true(toolNames.includes('apply_patch'));
});

test.serial('buildAgent includes native applyPatchTool for supported models', (t) => {
  const { deps, logger } = createDeps({ providerId: 'openai' });

  const result = buildAgent({ model: 'gpt-5.1' }, deps);

  t.true(result.agent.tools.some((tool: any) => tool.name === 'apply_patch'));
  t.true(logger.debugCalls.some(([message]) => message === 'Using native applyPatchTool from SDK'));
});

test.serial('buildAgent resolves codex default_reasoning_level', async (t) => {
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
  t.teardown(() => {
    clearModelCache();
    if (originalCodexProvider) {
      registerProvider(originalCodexProvider, { allowOverride: true });
    } else {
      unregisterProvider('codex');
    }
  });

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

  t.is(result.resolvedModel, 'gpt-5.3-codex');
  t.is(agent.modelSettings?.reasoning?.effort, 'medium');
  t.is(agent.defaultRunOptions?.reasoning?.effort, 'medium');
});

test.serial('buildAgent sets flex service tier when enabled', (t) => {
  const { deps } = createDeps({
    providerId: 'openai',
    settingsValues: {
      'agent.useFlexServiceTier': true,
    },
  });

  const result = buildAgent({ model: 'gpt-4o' }, deps);

  t.is(result.agent.modelSettings?.providerData?.service_tier, 'flex');
});

test.serial('buildAgent leaves parallel tool calls enabled by provider policy for Codex', (t) => {
  const { deps } = createDeps({
    providerId: 'codex',
    settingsValues: {
      'agent.model': 'gpt-5.4-mini',
    },
  });

  const result = buildAgent({ model: 'gpt-5.4-mini' }, deps);

  t.false('parallelToolCalls' in (result.agent.modelSettings ?? {}));
});

test.serial('buildAgent omits flex service tier when serviceTierOverrideForNextRequest is standard', (t) => {
  const { deps } = createDeps({
    providerId: 'openai',
    serviceTierOverrideForNextRequest: 'standard',
    settingsValues: {
      'agent.useFlexServiceTier': true,
    },
  });

  const result = buildAgent({ model: 'gpt-4o' }, deps);

  t.falsy(result.agent.modelSettings?.providerData?.service_tier);
});

test.serial('buildModelSettings omits reasoning when effort is default', (t) => {
  const { deps } = createDeps({
    providerId: 'openai',
    settingsValues: {
      'agent.reasoningEffort': 'default',
    },
  });

  const result = buildAgent({ model: 'gpt-4o', reasoningEffort: 'default' }, deps);

  t.falsy(result.agent.modelSettings?.reasoning);
});
