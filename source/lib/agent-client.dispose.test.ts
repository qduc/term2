import { expect, it, vi } from 'vitest';
import { AgentClient } from './agent-client.js';
import { registerProvider } from '../providers/registry.js';
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
