import { expect, it, vi } from 'vitest';
import { AgentClient } from './agent-client.js';
import { registerProvider, unregisterProvider } from '../providers/registry.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import type { SubagentBridge } from './subagent-bridge.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import { BackgroundShellRegistry } from '../services/shell/background-shell-registry.js';

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
    'agent.provider': 'mock-provider-dispose',
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
    get: (key: any) => store[key] as any,
    getDynamic: (key: string) => store[key],
    set: (key: string, value: any) => {
      store[key] = value;
    },
    setDynamic: (key: string, value: unknown) => {
      store[key] = value;
    },
    setPersistent: (key: string, value: unknown) => {
      store[key] = value;
    },
    setPersistentDynamic: (key: string, value: unknown) => {
      store[key] = value;
    },
    onChange(listener: (key?: string) => void) {
      this._listeners.push(listener);
      return () => {
        const idx = this._listeners.indexOf(listener);
        if (idx >= 0) this._listeners.splice(idx, 1);
      };
    },
  };
}

// ========== Mock Provider Registration ==========

let providerRegistered = false;
function ensureProviderRegistered() {
  if (!providerRegistered) {
    registerProvider(
      {
        id: 'mock-provider-dispose',
        label: 'Mock Dispose Provider',
        createStreamedModel: () => ({
          async *stream() {
            yield { type: 'completion', responseId: 'dispose-test', output: [] };
          },
        }),
        fetchModels: async () => [{ id: 'mock-model' }],
        clearConversations: () => {},
      },
      { allowOverride: true },
    );
    providerRegistered = true;
  }
}

// ========== Tests ==========

function createMockBridge() {
  return {
    abort: vi.fn(),
    dispose: vi.fn(),
    setEventSink: vi.fn(),
    setBackgroundEventSink: vi.fn(),
    resetAbortController: vi.fn(),
    clearCache: vi.fn(),
    clearSubagentCache: vi.fn(),
    cancelBackgroundRuns: vi.fn(),
  } as unknown as SubagentBridge;
}

it.sequential('dispose is idempotent — calling twice has single effect on bridge', () => {
  ensureProviderRegistered();
  const settings = createMockSettings();
  const mockBridge = createMockBridge();

  const client = new AgentClient({
    deps: {
      logger: createMockLogger(),
      settings,
      sessionContextService: {
        runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
        getContext: () => null,
      },
    },
    subagentBridge: mockBridge,
    toolOwnership: new ToolOwnershipRegistry(),
  });

  client.dispose();
  client.dispose();

  expect(mockBridge.dispose).toHaveBeenCalledTimes(1);
});

it.sequential('forwards root background shell events while explicit cancellation settles the job', async () => {
  ensureProviderRegistered();
  let release!: () => void;
  const registry = new BackgroundShellRegistry<any>({ createId: () => 'shell-job' });
  const client = new AgentClient({
    agentOverride: { name: 'override', model: 'mock-model', instructions: '', tools: [] },
    deps: {
      logger: createMockLogger(),
      settings: createMockSettings(),
      sessionContextService: {
        runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
        getContext: () => null,
      },
    },
    subagentBridge: createMockBridge(),
    toolOwnership: new ToolOwnershipRegistry(),
    backgroundShellRegistry: registry,
  });
  const events: any[] = [];
  client.setBackgroundShellEventSink((event) => events.push(event));
  const launch = registry.launch({
    command: 'safe-hold',
    run: (signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ output: 'cancelled output', status: 'failed' }), {
          once: true,
        });
        release = () => resolve({ output: 'done', status: 'completed' });
      }),
    resultToStatus: (result) => result.status,
  });

  client.cancelBackgroundShellJobs();
  await launch.settled;

  expect(events).toEqual([
    { type: 'background_shell_started', jobId: 'shell-job', command: 'safe-hold' },
    expect.objectContaining({
      type: 'background_shell_completed',
      jobId: 'shell-job',
      status: 'cancelled',
      output: 'cancelled output',
    }),
  ]);
  client.dispose();
  release();
});

it.sequential('dispose calls abort via subagentBridge', () => {
  ensureProviderRegistered();
  const settings = createMockSettings();
  const mockBridge = createMockBridge();

  const client = new AgentClient({
    deps: {
      logger: createMockLogger(),
      settings,
      sessionContextService: {
        runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
        getContext: () => null,
      },
    },
    subagentBridge: mockBridge,
    toolOwnership: new ToolOwnershipRegistry(),
  });

  client.dispose();

  // dispose calls abort() which calls bridge.abort()
  expect(mockBridge.abort).toHaveBeenCalledTimes(1);
  // dispose() also calls bridge.dispose()
  expect(mockBridge.dispose).toHaveBeenCalledTimes(1);
});

it.sequential('abort does not dispose the subagentBridge', () => {
  ensureProviderRegistered();
  const settings = createMockSettings();
  const mockBridge = createMockBridge();

  const client = new AgentClient({
    deps: {
      logger: createMockLogger(),
      settings,
      sessionContextService: {
        runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
        getContext: () => null,
      },
    },
    subagentBridge: mockBridge,
    toolOwnership: new ToolOwnershipRegistry(),
  });

  client.abort();

  // abort() calls bridge.abort() but NOT bridge.dispose()
  expect(mockBridge.abort).toHaveBeenCalledTimes(1);
  expect(mockBridge.dispose).not.toHaveBeenCalled();

  // dispose() later calls both
  client.dispose();
  expect(mockBridge.abort).toHaveBeenCalledTimes(2); // one from abort(), one from dispose()
  expect(mockBridge.dispose).toHaveBeenCalledTimes(1); // only from dispose()
});

it.sequential('setModel after dispose does not crash', () => {
  ensureProviderRegistered();
  const settings = createMockSettings();
  const mockBridge = createMockBridge();

  const client = new AgentClient({
    deps: {
      logger: createMockLogger(),
      settings,
      sessionContextService: {
        runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
        getContext: () => null,
      },
    },
    subagentBridge: mockBridge,
    toolOwnership: new ToolOwnershipRegistry(),
  });

  client.dispose();

  // After disposal, setModel should not cause errors
  expect(() => {
    client.setModel('gpt-4o-mini');
  }).not.toThrow();
});

it.sequential('setReasoningEffort after dispose does not crash', () => {
  ensureProviderRegistered();
  const settings = createMockSettings();
  const mockBridge = createMockBridge();

  const client = new AgentClient({
    deps: {
      logger: createMockLogger(),
      settings,
      sessionContextService: {
        runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
        getContext: () => null,
      },
    },
    subagentBridge: mockBridge,
    toolOwnership: new ToolOwnershipRegistry(),
  });

  client.dispose();

  expect(() => {
    client.setReasoningEffort('low');
  }).not.toThrow();
});

it.sequential('abort after dispose does not crash', () => {
  ensureProviderRegistered();
  const settings = createMockSettings();
  const mockBridge = createMockBridge();

  const client = new AgentClient({
    deps: {
      logger: createMockLogger(),
      settings,
      sessionContextService: {
        runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
        getContext: () => null,
      },
    },
    subagentBridge: mockBridge,
    toolOwnership: new ToolOwnershipRegistry(),
  });

  client.dispose();

  expect(() => {
    client.abort();
  }).not.toThrow();
});

it.sequential('cancelBackgroundRuns after dispose does not crash', () => {
  ensureProviderRegistered();
  const settings = createMockSettings();
  const mockBridge = createMockBridge();

  const client = new AgentClient({
    deps: {
      logger: createMockLogger(),
      settings,
      sessionContextService: {
        runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
        getContext: () => null,
      },
    },
    subagentBridge: mockBridge,
    toolOwnership: new ToolOwnershipRegistry(),
  });

  client.dispose();

  expect(() => {
    client.cancelBackgroundRuns();
  }).not.toThrow();
});

it.sequential('dispose without subagentBridge works safely', () => {
  ensureProviderRegistered();
  const settings = createMockSettings();

  const client = new AgentClient({
    deps: {
      logger: createMockLogger(),
      settings,
      sessionContextService: {
        runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
        getContext: () => null,
      },
    },
    agentOverride: {
      name: 'TestAgent',
      model: 'test-model',
      clone: () => ({
        name: 'TestAgent',
        model: 'test-model',
        clone: () => ({}),
      }),
    } as any,
    toolOwnership: new ToolOwnershipRegistry(),
  });

  // Transient clients (with agentOverride) do not create a SubagentBridge
  // dispose should still work correctly
  expect(() => {
    client.dispose();
    client.dispose();
  }).not.toThrow();
});

it.sequential('disposing one transient client does not close a shared streamed model', async () => {
  const providerId = 'mock-shared-streamed-model-dispose';
  let release!: () => void;
  let markStarted!: () => void;
  let startedCount = 0;
  const bothStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let interrupted = false;
  const close = vi.fn(() => {
    interrupted = true;
  });
  const sharedModel = {
    close,
    async *stream() {
      startedCount += 1;
      if (startedCount === 2) markStarted();
      await released;
      if (interrupted) throw new Error('shared model was closed');
      yield { type: 'completion' as const, responseId: 'shared-response', output: [] };
    },
  };
  const createStreamedModel = vi.fn(() => sharedModel);
  registerProvider(
    {
      id: providerId,
      label: 'Shared streamed model dispose test provider',
      createStreamedModel,
      fetchModels: async () => [],
    },
    { allowOverride: true },
  );

  const sessionContextService = {
    runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
    getContext: () => null,
  };
  const createTransientClient = () =>
    new AgentClient({
      agentOverride: { name: 'transient', model: 'shared-model', instructions: '', tools: [] },
      providerOverride: providerId,
      deps: {
        logger: createMockLogger(),
        settings: createMockSettings({ 'agent.provider': providerId, 'agent.model': 'shared-model' }),
        sessionContextService,
      },
      toolOwnership: new ToolOwnershipRegistry(),
    });

  let firstClient: AgentClient | undefined;
  let secondClient: AgentClient | undefined;
  try {
    firstClient = createTransientClient();
    secondClient = createTransientClient();
    const first = await firstClient.startStream('first');
    const second = await secondClient.startStream('second');
    const firstCompletion = first.completed.catch(() => undefined);
    const secondCompletion = second.completed;

    await bothStarted;
    // A transient client only owns its reference to a session-shared model.
    // Closing that reference must not close the model or interrupt its sibling.
    // The first client is intentionally disposed after both requests are live.
    // (The second client remains alive until the shared stream settles.)
    firstClient.dispose();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    release();
    await Promise.all([firstCompletion, secondCompletion]);
    expect(close).not.toHaveBeenCalled();
    expect(createStreamedModel).toHaveBeenCalledTimes(2);
  } finally {
    release();
    firstClient?.dispose();
    secondClient?.dispose();
    unregisterProvider(providerId);
  }
});
