import { expect, it, vi } from 'vitest';
import { AgentClient } from './agent-client.js';
import { registerProvider, unregisterProvider } from '../providers/registry.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import { RetryingModel } from '../providers/retrying-model.js';

const settings = {
  get(key: string): unknown {
    return {
      'agent.provider': 'openai',
      'agent.model': 'gpt-5.6-luna',
      'agent.transport': 'http',
      'agent.retryAttempts': 0,
    }[key];
  },
  // ISettingsService.getDynamic is read unconditionally by the tool-capability
  // mask in getAgentDefinition.
  getDynamic(key: string): unknown {
    return this.get(key);
  },
} as any;

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  security() {},
  setCorrelationId() {},
  clearCorrelationId() {},
  getCorrelationId() {
    return undefined;
  },
  log() {},
} as any;

function makeLifecycleClient(providerId: string, agentOverride?: any): AgentClient {
  return new AgentClient({
    ...(agentOverride ? { agentOverride } : {}),
    providerOverride: providerId,
    deps: {
      logger,
      settings: {
        get(key: string): unknown {
          if (key === 'agent.provider') return providerId;
          if (key === 'agent.model') return 'lifecycle-model';
          return settings.get(key);
        },
        getDynamic(key: string): unknown {
          return this.get(key);
        },
      } as any,
      sessionContextService: {
        runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
        getContext: () => null,
      } as any,
    },
    toolOwnership: new ToolOwnershipRegistry(),
  });
}

function completedModel(resetConversationState?: (options?: any) => void) {
  return {
    ...(resetConversationState ? { resetConversationState } : {}),
    async *stream() {
      yield { type: 'completion' as const, responseId: 'lifecycle-response', output: [] };
    },
  };
}

it('application-owned HTTP Responses providers retain their chaining capability', () => {
  const client = new AgentClient({
    deps: {
      logger,
      settings,
      sessionContextService: {
        runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
        getContext: () => null,
      } as any,
    },
    toolOwnership: new ToolOwnershipRegistry(),
  });

  expect(client.supportsConversationChaining()).toBe(true);
});

it.sequential('does not retain a cached provider model that has no reset seam across rollover', async () => {
  const providerId = 'mock-rollover-unsupported-provider';
  const close = vi.fn();
  const createStreamedModel = vi.fn(
    () => new RetryingModel({ ...completedModel(), close } as any, { retryAttempts: 0 }),
  );
  registerProvider(
    { id: providerId, label: 'Rollover unsupported provider', createStreamedModel, fetchModels: async () => [] },
    { allowOverride: true },
  );
  const client = makeLifecycleClient(providerId);
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'text', text: 'before' }] },
    { type: 'message', role: 'user', content: [{ type: 'text', text: 'context' }] },
  ];

  try {
    await (
      await client.startStream(input as any, { sessionId: 'before' })
    ).completed;
    expect(createStreamedModel).toHaveBeenCalledTimes(1);
    client.rolloverRootContext();
    await (
      await client.startStream(input as any, { sessionId: 'after' })
    ).completed;

    expect(createStreamedModel).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    client.dispose();
    unregisterProvider(providerId);
  }
});

it.sequential('does not reset a borrowed model during root rollover', async () => {
  const providerId = 'mock-rollover-borrowed-provider';
  const resetConversationState = vi.fn();
  const model = completedModel(resetConversationState);
  registerProvider(
    {
      id: providerId,
      label: 'Rollover borrowed provider',
      createStreamedModel: () => model,
      fetchModels: async () => [],
    },
    { allowOverride: true },
  );
  const client = makeLifecycleClient(providerId, {
    name: 'transient',
    model: 'lifecycle-model',
    instructions: '',
    tools: [],
  });

  try {
    await (
      await client.startStream('before', { sessionId: 'before' })
    ).completed;
    client.rolloverRootContext();

    expect(resetConversationState).not.toHaveBeenCalled();
  } finally {
    client.dispose();
    unregisterProvider(providerId);
  }
});

it.sequential('does not invoke a reset seam when rollover has no logical session key', async () => {
  const providerId = 'mock-rollover-unkeyed-provider';
  const resetConversationState = vi.fn();
  const model = completedModel(resetConversationState);
  registerProvider(
    {
      id: providerId,
      label: 'Rollover unkeyed provider',
      createStreamedModel: () => model,
      fetchModels: async () => [],
    },
    { allowOverride: true },
  );
  const client = makeLifecycleClient(providerId);

  try {
    await (
      await client.startStream('before')
    ).completed;
    client.rolloverRootContext();

    expect(resetConversationState).not.toHaveBeenCalled();
  } finally {
    client.dispose();
    unregisterProvider(providerId);
  }
});
