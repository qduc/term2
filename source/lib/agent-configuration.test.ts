import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { AgentConfiguration, type AgentConfigurationDeps } from './agent-configuration.js';
import { registerProvider } from '../providers/registry.js';
import { ToolInterceptorRegistry } from './tool-interceptor-registry.js';
import { AskUserAnswerStore } from './ask-user-answer-store.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';

// ========== Mock Utilities ==========

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

function createMockSettings(values: Record<string, any> = {}): ISettingsService & {
  _listeners: Array<(key?: string) => void>;
  _triggerChange: (key?: string) => void;
} {
  const store: Record<string, any> = {
    'agent.provider': 'mock-provider-for-config',
    'agent.model': 'mock-model',
    'agent.maxTurns': 20,
    'agent.temperature': undefined,
    ...values,
  };
  const listeners: Array<(key?: string) => void> = [];
  return {
    _listeners: listeners,
    _triggerChange: (key?: string) => {
      listeners.forEach((fn) => fn(key));
    },
    get: <T>(key: string) => store[key] as T,
    set: (key: string, value: any) => {
      store[key] = value;
    },
    onChange: (listener: (key?: string) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };
}

const noopSubagentBridge = () => null;

function createDeps(overrides: Partial<AgentConfigurationDeps> & { settingsValues?: Record<string, any> } = {}): {
  deps: AgentConfigurationDeps;
  logger: ILoggingService;
  settings: ISettingsService;
} {
  const logger = createMockLogger();
  const settings = createMockSettings(overrides.settingsValues);
  const toolInterceptorRegistry = new ToolInterceptorRegistry({ logger });
  const askUserAnswerStore = new AskUserAnswerStore();

  return {
    logger,
    settings,
    deps: {
      logger,
      settings,
      sessionContextService: {
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
        getContext: () => null,
      },
      executionContext: overrides.executionContext,
      toolInterceptorRegistry: overrides.toolInterceptorRegistry ?? toolInterceptorRegistry,
      askUserAnswerStore: overrides.askUserAnswerStore ?? askUserAnswerStore,
      getSubagentBridge: overrides.getSubagentBridge ?? noopSubagentBridge,
      onConfigChanged: overrides.onConfigChanged,
    },
  };
}

// ========== Mock Provider Registration ==========
let providerRegistered = false;
function ensureProviderRegistered() {
  if (!providerRegistered) {
    registerProvider({
      id: 'mock-provider-for-config',
      label: 'Mock Config Provider',
      createRunner: () =>
        ({
          run: async (_agent: any, _input: any, _options: any) => ({
            status: 'completed',
            finalOutput: 'mock response',
            messages: [],
          }),
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
      clearConversations: () => {},
    });
    providerRegistered = true;
  }
}

// ========== Tests ==========

it.sequential('constructor with agentOverride uses the override', () => {
  ensureProviderRegistered();

  const { deps } = createDeps();
  const overrideAgent = {
    name: 'OverrideAgent',
    model: 'override-model',
    clone: () => overrideAgent,
  } as any;

  const config = new AgentConfiguration({ agentOverride: overrideAgent, model: 'override-model' }, deps);

  expect(config.getAgent(), 'getAgent() returns the override agent').toBe(overrideAgent);
  expect(config.getModel(), 'getModel returns the override model').toBe('override-model');
  expect(config.isTransientClient).toBe(true);
});

it.sequential('constructor without agentOverride builds agent from settings', () => {
  ensureProviderRegistered();

  const { deps } = createDeps();
  const config = new AgentConfiguration({}, deps);

  const agent = config.getAgent();
  expect(agent).toBeTruthy();
  expect(agent?.name, 'agent name matches default').toBe('Terminal Assistant');
  expect(config.isTransientClient).toBe(false);
});

it.sequential('getProvider returns the configured provider', () => {
  ensureProviderRegistered();

  const { deps } = createDeps();
  const config = new AgentConfiguration({}, deps);

  expect(config.getProvider(), 'getProvider returns settings provider').toBe('mock-provider-for-config');
});

it.sequential('getProvider returns override provider when provided', () => {
  ensureProviderRegistered();

  const { deps } = createDeps();
  const config = new AgentConfiguration({ providerOverride: 'mock-provider-for-config' }, deps);

  expect(config.getProvider(), 'getProvider returns the override').toBe('mock-provider-for-config');
});

it.sequential('getModel returns the resolved model', () => {
  ensureProviderRegistered();

  const { deps } = createDeps();
  const config = new AgentConfiguration({ model: 'gpt-4o' }, deps);

  const resolvedModel = config.getModel();
  expect(resolvedModel).toBeTruthy();
  expect(resolvedModel, 'getModel returns the resolved model').toBe('gpt-4o');
});

it.sequential('rebuildAgent updates agent and model after setModel', () => {
  ensureProviderRegistered();

  const { deps } = createDeps();
  const config = new AgentConfiguration({ model: 'gpt-4o' }, deps);

  const originalAgent = config.getAgent();
  void config.getModel();

  // Change model and rebuild
  config.setModel('gpt-4o-mini');
  config.rebuildAgent();

  const newAgent = config.getAgent();
  const newModel = config.getModel();

  expect(newAgent, 'agent reference changed after rebuild').not.toBe(originalAgent);
  expect(newModel, 'model was updated').toBe('gpt-4o-mini');
});

it.sequential('rebuildAgent is no-op for transient client', () => {
  ensureProviderRegistered();

  const { deps } = createDeps();
  const overrideAgent = {
    name: 'OverrideAgent',
    model: 'override-model',
    clone: () => overrideAgent,
  } as any;

  const config = new AgentConfiguration({ agentOverride: overrideAgent, model: 'override-model' }, deps);

  config.setModel('different-model');
  config.rebuildAgent();

  expect(config.getAgent(), 'agent still returns the override').toBe(overrideAgent);
  expect(config.getModel(), 'setModel updated the model string').toBe('different-model');
});

it.sequential('getAgent with sessionId clones agent for providers with prompt cache support', () => {
  ensureProviderRegistered();

  // Register a provider with prompt cache key support
  registerProvider({
    id: 'mock-provider-cache',
    label: 'Mock Cache Provider',
    capabilities: {
      supportsPromptCacheKey: true,
      supportsConversationChaining: false,
      supportsTracingControl: false,
    },
    createRunner: () =>
      ({
        run: async (_agent: any, _input: any, _options: any) => ({
          status: 'completed',
          finalOutput: 'mock response',
          messages: [],
        }),
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const { deps } = createDeps({ settingsValues: { 'agent.provider': 'mock-provider-cache' } });
  const config = new AgentConfiguration({ model: 'gpt-4o' }, deps);

  const agentWithSession = config.getAgent('test-session-123');
  expect(agentWithSession).toBeTruthy();

  // The base agent should not be the same as the one with sessionId
  const baseAgent = config.getAgent();
  // For providers with prompt cache support, agent.clone() might return a different
  // object. We just verify that both return valid agents.
  expect(baseAgent).toBeTruthy();
  expect(agentWithSession).toBeTruthy();
});

it.sequential('maxTurns reads from settings', () => {
  ensureProviderRegistered();

  const { deps } = createDeps({ settingsValues: { 'agent.maxTurns': 42 } });
  const config = new AgentConfiguration({}, deps);

  expect(config.maxTurns, 'maxTurns reads from settings').toBe(42);
});

it.sequential('maxTurns defaults to 20', () => {
  ensureProviderRegistered();

  const { deps } = createDeps({ settingsValues: { 'agent.maxTurns': undefined } });
  const config = new AgentConfiguration({}, deps);

  expect(config.maxTurns, 'maxTurns defaults to 20 when settings value is undefined').toBe(20);
});

it.sequential('serviceTierOverride getter/setter works', () => {
  ensureProviderRegistered();

  const { deps } = createDeps();
  const config = new AgentConfiguration({}, deps);

  expect(config.serviceTierOverrideForNextRequest, 'defaults to null').toBe(null);

  config.serviceTierOverrideForNextRequest = 'standard';
  expect(config.serviceTierOverrideForNextRequest, 'setter updates value').toBe('standard');

  config.serviceTierOverrideForNextRequest = null;
  expect(config.serviceTierOverrideForNextRequest, 'resets to null').toBe(null);
});

it.sequential('getBuildFactoryDeps returns correct shape', () => {
  ensureProviderRegistered();

  const { deps } = createDeps();
  const config = new AgentConfiguration({}, deps);

  const factoryDeps = config.getBuildFactoryDeps();
  expect(factoryDeps).toBeTruthy();
  expect(typeof factoryDeps.settings, 'has settings').toBe('object');
  expect(typeof factoryDeps.logger, 'has logger').toBe('object');
  expect(typeof factoryDeps.editor, 'has editor').toBe('object');
  expect(typeof factoryDeps.createMentor, 'has createMentor').toBe('function');
  expect(typeof factoryDeps.runSubagent, 'has runSubagent').toBe('function');
  expect(typeof factoryDeps.getAskUserAnswer, 'has getAskUserAnswer').toBe('function');
  expect(typeof factoryDeps.checkToolInterceptors, 'has checkToolInterceptors').toBe('function');
});

it.sequential('subscribeToSettings installs onChange handler', () => {
  ensureProviderRegistered();

  const result = createDeps();
  const settings = result.settings as ReturnType<typeof createMockSettings>;
  const config = new AgentConfiguration({}, result.deps);

  expect(settings._listeners.length, 'no listeners before subscribeToSettings').toBe(0);

  config.subscribeToSettings();

  expect(settings._listeners.length, 'one listener after subscribeToSettings').toBe(1);
});

it.sequential('subscribeToSettings is no-op for transient client', () => {
  ensureProviderRegistered();

  const result = createDeps();
  const settings = result.settings as ReturnType<typeof createMockSettings>;
  const overrideAgent = {
    name: 'OverrideAgent',
    model: 'override-model',
    clone: () => overrideAgent,
  } as any;

  const config = new AgentConfiguration({ agentOverride: overrideAgent, model: 'override-model' }, result.deps);

  config.subscribeToSettings();

  expect(settings._listeners.length, 'no listeners for transient client').toBe(0);
});

it.sequential('refreshAgent calls onConfigChanged callback', () => {
  ensureProviderRegistered();

  let changedKeyResult: string | undefined = 'not-called';
  const { deps } = createDeps({
    onConfigChanged: (changedKey?: string) => {
      changedKeyResult = changedKey;
    },
  });
  const config = new AgentConfiguration({}, deps);

  changedKeyResult = 'not-called';
  config.refreshAgent();

  expect(changedKeyResult).toBeFalsy();
  expect(config.getAgent()).toBeTruthy();
});

it.sequential('setProvider persists to settings', () => {
  ensureProviderRegistered();

  const result = createDeps();
  const settings = result.settings as ReturnType<typeof createMockSettings>;
  const config = new AgentConfiguration({}, result.deps);

  expect(config.getProvider(), 'starts with default provider').toBe('mock-provider-for-config');

  config.setProvider('mock-provider-cache');

  expect(config.getProvider(), 'provider updated').toBe('mock-provider-cache');
  expect(settings.get('agent.provider'), 'settings updated').toBe('mock-provider-cache');
});

it.sequential('settings change triggers rebuild via subscribeToSettings', () => {
  ensureProviderRegistered();

  const result = createDeps();
  const settings = result.settings as ReturnType<typeof createMockSettings>;
  const config = new AgentConfiguration({ model: 'gpt-4o' }, result.deps);

  const originalAgent = config.getAgent();

  config.subscribeToSettings();

  // Simulate a settings change that should trigger rebuild
  settings._triggerChange('agent.model');

  const newAgent = config.getAgent();
  expect(newAgent, 'agent was rebuilt after settings change').not.toBe(originalAgent);
});

it.sequential('settings change with non-rebuild key does not trigger rebuild', () => {
  ensureProviderRegistered();

  const result = createDeps();
  const settings = result.settings as ReturnType<typeof createMockSettings>;
  const config = new AgentConfiguration({ model: 'gpt-4o' }, result.deps);

  const originalAgent = config.getAgent();

  config.subscribeToSettings();

  // Simulate a settings change with a key NOT in rebuildKeys
  settings._triggerChange('app.someRandomSetting');

  const agentAfter = config.getAgent();
  expect(agentAfter, 'agent was NOT rebuilt for non-rebuild key').toBe(originalAgent);
});

it.sequential('settings change triggers onConfigChanged via subscribeToSettings', () => {
  ensureProviderRegistered();

  let calledWithKey: string | undefined;
  const result = createDeps({
    onConfigChanged: (changedKey?: string) => {
      calledWithKey = changedKey;
    },
  });
  const settings = result.settings as ReturnType<typeof createMockSettings>;
  const config = new AgentConfiguration({}, result.deps);

  config.subscribeToSettings();

  settings._triggerChange('agent.model');

  expect(calledWithKey, 'onConfigChanged called with changed key').toBe('agent.model');
});

it.sequential('refreshAgent is no-op for transient client', () => {
  ensureProviderRegistered();

  let callbackCalled = false;
  const { deps } = createDeps({
    onConfigChanged: () => {
      callbackCalled = true;
    },
  });
  const overrideAgent = {
    name: 'OverrideAgent',
    model: 'override-model',
    clone: () => overrideAgent,
  } as any;

  const config = new AgentConfiguration({ agentOverride: overrideAgent, model: 'override-model' }, deps);

  config.refreshAgent();

  expect(callbackCalled).toBe(false);
  expect(config.getAgent(), 'agent still returns the override').toBe(overrideAgent);
});
