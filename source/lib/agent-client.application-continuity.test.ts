import { expect, it, vi } from 'vitest';
import { AgentClient } from './agent-client.js';
import { registerProvider, unregisterProvider } from '../providers/registry.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import { RetryingModel } from '../providers/retrying-model.js';
import { z } from 'zod';

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

it.sequential('routes tool-batch diagnostics to debug with stable event identities', async () => {
  const providerId = 'tool-batch-diagnostic-routing-provider';
  const debugLogs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const infoLogs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  let requests = 0;
  registerProvider(
    {
      id: providerId,
      label: 'Tool-batch diagnostic routing provider',
      createStreamedModel: () => ({
        async *stream() {
          requests += 1;
          if (requests === 1) {
            yield {
              type: 'completion' as const,
              responseId: 'tool-batch-response',
              output: [{ type: 'tool_call' as const, id: 'call-1', name: 'lookup', arguments: '{}' }],
            };
            return;
          }
          yield { type: 'completion' as const, responseId: 'tool-batch-done', output: [] };
        },
      }),
      fetchModels: async () => [],
    },
    { allowOverride: true },
  );
  const testLogger = {
    ...logger,
    debug: (message: string, meta?: Record<string, unknown>) => debugLogs.push({ message, meta }),
    info: (message: string, meta?: Record<string, unknown>) => infoLogs.push({ message, meta }),
  };
  const client = new AgentClient({
    providerOverride: providerId,
    maxTurns: 2,
    agentOverride: {
      name: 'diagnostic-routing-agent',
      model: 'lifecycle-model',
      instructions: 'test',
      tools: [
        {
          name: 'lookup',
          description: 'lookup',
          parameters: z.object({}),
          needsApproval: async () => false,
          execute: async () => 'result',
          formatCommandMessage: () => [],
        },
      ],
    },
    deps: {
      logger: testLogger,
      settings: {
        get(key: string): unknown {
          if (key === 'agent.provider') return providerId;
          if (key === 'agent.model') return 'lifecycle-model';
          if (key === 'agent.retryAttempts') return 0;
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

  try {
    const stream = await client.startStream('run');
    await stream.completed;
    expect(debugLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'tool parallel eligibility',
          meta: expect.objectContaining({ eventType: 'tool.parallel.eligibility' }),
        }),
        expect.objectContaining({
          message: 'tool batch dispatched',
          meta: expect.objectContaining({ eventType: 'tool.batch.dispatched' }),
        }),
        expect.objectContaining({
          message: 'tool batch settled',
          meta: expect.objectContaining({ eventType: 'tool.batch.settled' }),
        }),
      ]),
    );
    expect(infoLogs.some(({ message }) => message.startsWith('tool '))).toBe(false);
  } finally {
    client.dispose();
    unregisterProvider(providerId);
  }
});
