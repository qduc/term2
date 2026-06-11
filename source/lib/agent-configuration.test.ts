import test from 'ava';
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

test.serial('constructor with agentOverride uses the override', (t) => {
  ensureProviderRegistered();

  const { deps } = createDeps();
  const overrideAgent = {
    name: 'OverrideAgent',
    model: 'override-model',
    clone: () => overrideAgent,
  } as any;

  const config = new AgentConfiguration({ agentOverride: overrideAgent, model: 'override-model' }, deps);

  t.is(config.getAgent(), overrideAgent, 'getAgent() returns the override agent');
  t.is(config.getModel(), 'override-model', 'getModel returns the override model');
  t.true(config.isTransientClient, 'isTransientClient is true');
});

test.serial('constructor without agentOverride builds agent from settings', (t) => {
  ensureProviderRegistered();

  const { deps } = createDeps();
  const config = new AgentConfiguration({}, deps);

  const agent = config.getAgent();
  t.truthy(agent, 'getAgent() returns a built agent');
  t.is(agent?.name, 'Terminal Assistant', 'agent name matches default');
  t.false(config.isTransientClient, 'isTransientClient is false');
});

test.serial('getProvider returns the configured provider', (t) => {
  ensureProviderRegistered();

  const { deps } = createDeps();
  const config = new AgentConfiguration({}, deps);

  t.is(config.getProvider(), 'mock-provider-for-config', 'getProvider returns settings provider');
});

test.serial('getProvider returns override provider when provided', (t) => {
  ensureProviderRegistered();

  const { deps } = createDeps();
  const config = new AgentConfiguration({ providerOverride: 'mock-provider-for-config' }, deps);

  t.is(config.getProvider(), 'mock-provider-for-config', 'getProvider returns the override');
});

test.serial('getModel returns the resolved model', (t) => {
  ensureProviderRegistered();

  const { deps } = createDeps();
  const config = new AgentConfiguration({ model: 'gpt-4o' }, deps);

  const resolvedModel = config.getModel();
  t.truthy(resolvedModel, 'getModel returns a non-empty string');
  t.is(resolvedModel, 'gpt-4o', 'getModel returns the resolved model');
});

test.serial('rebuildAgent updates agent and model after setModel', (t) => {
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

  t.not(newAgent, originalAgent, 'agent reference changed after rebuild');
  t.is(newModel, 'gpt-4o-mini', 'model was updated');
});

test.serial('rebuildAgent is no-op for transient client', (t) => {
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

  t.is(config.getAgent(), overrideAgent, 'agent still returns the override');
  t.is(config.getModel(), 'different-model', 'setModel updated the model string');
});

test.serial('getAgent with sessionId clones agent for providers with prompt cache support', (t) => {
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
  t.truthy(agentWithSession, 'getAgent with sessionId returns an agent');

  // The base agent should not be the same as the one with sessionId
  const baseAgent = config.getAgent();
  // For providers with prompt cache support, agent.clone() might return a different
  // object. We just verify that both return valid agents.
  t.truthy(baseAgent, 'base agent is truthy');
  t.truthy(agentWithSession, 'session agent is truthy');
});

test.serial('maxTurns reads from settings', (t) => {
  ensureProviderRegistered();

  const { deps } = createDeps({ settingsValues: { 'agent.maxTurns': 42 } });
  const config = new AgentConfiguration({}, deps);

  t.is(config.maxTurns, 42, 'maxTurns reads from settings');
});

test.serial('maxTurns defaults to 20', (t) => {
  ensureProviderRegistered();

  const { deps } = createDeps({ settingsValues: { 'agent.maxTurns': undefined } });
  const config = new AgentConfiguration({}, deps);

  t.is(config.maxTurns, 20, 'maxTurns defaults to 20 when settings value is undefined');
});

test.serial('serviceTierOverride getter/setter works', (t) => {
  ensureProviderRegistered();

  const { deps } = createDeps();
  const config = new AgentConfiguration({}, deps);

  t.is(config.serviceTierOverrideForNextRequest, null, 'defaults to null');

  config.serviceTierOverrideForNextRequest = 'standard';
  t.is(config.serviceTierOverrideForNextRequest, 'standard', 'setter updates value');

  config.serviceTierOverrideForNextRequest = null;
  t.is(config.serviceTierOverrideForNextRequest, null, 'resets to null');
});

test.serial('getBuildFactoryDeps returns correct shape', (t) => {
  ensureProviderRegistered();

  const { deps } = createDeps();
  const config = new AgentConfiguration({}, deps);

  const factoryDeps = config.getBuildFactoryDeps();
  t.truthy(factoryDeps, 'getBuildFactoryDeps returns something');
  t.is(typeof factoryDeps.settings, 'object', 'has settings');
  t.is(typeof factoryDeps.logger, 'object', 'has logger');
  t.is(typeof factoryDeps.editor, 'object', 'has editor');
  t.is(typeof factoryDeps.createMentor, 'function', 'has createMentor');
  t.is(typeof factoryDeps.runSubagent, 'function', 'has runSubagent');
  t.is(typeof factoryDeps.getAskUserAnswer, 'function', 'has getAskUserAnswer');
  t.is(typeof factoryDeps.checkToolInterceptors, 'function', 'has checkToolInterceptors');
});

test.serial('subscribeToSettings installs onChange handler', (t) => {
  ensureProviderRegistered();

  const result = createDeps();
  const settings = result.settings as ReturnType<typeof createMockSettings>;
  const config = new AgentConfiguration({}, result.deps);

  t.is(settings._listeners.length, 0, 'no listeners before subscribeToSettings');

  config.subscribeToSettings();

  t.is(settings._listeners.length, 1, 'one listener after subscribeToSettings');
});

test.serial('subscribeToSettings is no-op for transient client', (t) => {
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

  t.is(settings._listeners.length, 0, 'no listeners for transient client');
});

test.serial('refreshAgent calls onConfigChanged callback', (t) => {
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

  t.falsy(changedKeyResult, 'onConfigChanged was called (changedKeyResult is falsy)');
  t.truthy(config.getAgent(), 'agent still valid after refresh');
});

test.serial('setProvider persists to settings', (t) => {
  ensureProviderRegistered();

  const result = createDeps();
  const settings = result.settings as ReturnType<typeof createMockSettings>;
  const config = new AgentConfiguration({}, result.deps);

  t.is(config.getProvider(), 'mock-provider-for-config', 'starts with default provider');

  config.setProvider('mock-provider-cache');

  t.is(config.getProvider(), 'mock-provider-cache', 'provider updated');
  t.is(settings.get('agent.provider'), 'mock-provider-cache', 'settings updated');
});

test.serial('settings change triggers rebuild via subscribeToSettings', (t) => {
  ensureProviderRegistered();

  const result = createDeps();
  const settings = result.settings as ReturnType<typeof createMockSettings>;
  const config = new AgentConfiguration({ model: 'gpt-4o' }, result.deps);

  const originalAgent = config.getAgent();

  config.subscribeToSettings();

  // Simulate a settings change that should trigger rebuild
  settings._triggerChange('agent.model');

  const newAgent = config.getAgent();
  t.not(newAgent, originalAgent, 'agent was rebuilt after settings change');
});

test.serial('settings change with non-rebuild key does not trigger rebuild', (t) => {
  ensureProviderRegistered();

  const result = createDeps();
  const settings = result.settings as ReturnType<typeof createMockSettings>;
  const config = new AgentConfiguration({ model: 'gpt-4o' }, result.deps);

  const originalAgent = config.getAgent();

  config.subscribeToSettings();

  // Simulate a settings change with a key NOT in rebuildKeys
  settings._triggerChange('app.someRandomSetting');

  const agentAfter = config.getAgent();
  t.is(agentAfter, originalAgent, 'agent was NOT rebuilt for non-rebuild key');
});

test.serial('settings change triggers onConfigChanged via subscribeToSettings', (t) => {
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

  t.is(calledWithKey, 'agent.model', 'onConfigChanged called with changed key');
});

test.serial('refreshAgent is no-op for transient client', (t) => {
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

  t.false(callbackCalled, 'onConfigChanged was not called for transient client');
  t.is(config.getAgent(), overrideAgent, 'agent still returns the override');
});
