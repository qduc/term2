import { it, expect, beforeAll } from 'vitest';
import { AgentChatService } from './agent-chat-service.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { registerProvider } from '../providers/registry.js';

// Module-level capture variable used by the mock runner
let lastRunRequest: any = null;
let completionText = 'mock response';

function mockStreamedModel(): any {
  return {
    async *stream(request: any) {
      lastRunRequest = request;
      yield {
        type: 'completion',
        responseId: 'mock-response',
        output: [{ type: 'message', content: [{ type: 'text', text: completionText }] }],
      };
    },
  };
}

const mockLogger: ILoggingService = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  setCorrelationId: () => {},
  clearCorrelationId: () => {},
  log: () => {},
} as any;

function createMockSettings(providerId: string): ISettingsService {
  return {
    get: (key: string) => {
      if (key === 'agent.provider') return providerId;
      if (key === 'agent.model') return 'mock-model';
      return undefined;
    },
    set: () => {},
    onChange: () => () => {},
  } as any;
}

class MockAgentConfig {
  #provider: string;
  #model: string;

  constructor(provider: string, model: string) {
    this.#provider = provider;
    this.#model = model;
  }

  getProvider(): string {
    return this.#provider;
  }

  getModel(): string {
    return this.#model;
  }

  get reasoningEffort(): undefined {
    return undefined;
  }

  refreshAgent(): void {
    // no-op
  }

  getAgent(): any {
    return null;
  }
}

beforeAll(() => {
  lastRunRequest = null;
  registerProvider(
    {
      id: 'mock-provider',
      label: 'Mock provider',
      createStreamedModel: () => mockStreamedModel(),
      fetchModels: async () => [],
    },
    { allowOverride: true },
  );
  registerProvider(
    {
      id: 'other-provider',
      label: 'Other provider',
      createStreamedModel: () => mockStreamedModel(),
      fetchModels: async () => [],
    },
    { allowOverride: true },
  );
});

it.sequential('chat caches models by provider and model and clears explicitly', async () => {
  let created = 0;
  const providerId = 'chat-cache-provider';
  registerProvider(
    {
      id: providerId,
      label: 'Chat cache provider',
      createStreamedModel: () => {
        created += 1;
        return mockStreamedModel();
      },
      fetchModels: async () => [],
    },
    { allowOverride: true },
  );
  const service = new AgentChatService({
    agentConfig: new MockAgentConfig(providerId, 'cached-model') as any,
    settings: createMockSettings(providerId),
    logger: mockLogger,
  });
  await service.chat('one');
  await service.chat('two');
  expect(created).toBe(1);
  service.clearModelCache();
  await service.chat('three');
  expect(created).toBe(2);
});

it.sequential('chat returns extracted response from agent run', async () => {
  lastRunRequest = null;

  const service = new AgentChatService({
    agentConfig: new MockAgentConfig('mock-provider', 'mock-model') as any,
    settings: createMockSettings('mock-provider'),
    logger: mockLogger,
  });

  const response = await service.chat('Hello');
  expect(response).toBe('mock response');
});

it.sequential('abort cancels an active chat run', async () => {
  let observedAbort = false;
  const providerId = 'chat-abort-provider';
  registerProvider(
    {
      id: providerId,
      label: 'Chat abort provider',
      createStreamedModel: () => ({
        async *stream(request: { signal?: AbortSignal }) {
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) {
              observedAbort = true;
              resolve();
              return;
            }
            request.signal?.addEventListener(
              'abort',
              () => {
                observedAbort = true;
                resolve();
              },
              { once: true },
            );
          });
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        },
      }),
      fetchModels: async () => [],
    },
    { allowOverride: true },
  );
  const service = new AgentChatService({
    agentConfig: new MockAgentConfig(providerId, 'mock-model') as any,
    settings: createMockSettings(providerId),
    logger: mockLogger,
  });

  try {
    const pending = service.chat('cancel me');
    await Promise.resolve();
    service.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedAbort).toBe(true);
  } finally {
    registerProvider(
      {
        id: providerId,
        label: 'Chat abort provider',
        createStreamedModel: () => mockStreamedModel(),
        fetchModels: async () => [],
      },
      { allowOverride: true },
    );
  }
});

it.sequential('chat with temp provider builds temp agent', async () => {
  lastRunRequest = null;

  const service = new AgentChatService({
    agentConfig: new MockAgentConfig('mock-provider', 'mock-model') as any,
    settings: createMockSettings('mock-provider'),
    logger: mockLogger,
  });

  await service.chat('Hello', { provider: 'other-provider' });

  expect(lastRunRequest).toBeTruthy();
});

it.sequential('chatJson passes outputType to temp agent', async () => {
  lastRunRequest = null;

  const service = new AgentChatService({
    agentConfig: new MockAgentConfig('mock-provider', 'mock-model') as any,
    settings: createMockSettings('mock-provider'),
    logger: mockLogger,
  });

  await service.chatJson('Return JSON', {
    outputType: {
      type: 'json_schema',
      name: 'test_output',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
        },
        required: ['ok'],
      },
    },
  });

  expect(lastRunRequest).toBeTruthy();
  expect(lastRunRequest.outputType).toEqual({
    type: 'json_schema',
    name: 'test_output',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
      },
      required: ['ok'],
    },
  });
});

it.sequential('chatJson falls back to message content when finalOutput is empty', async () => {
  completionText = '{"results":[{"reasoning":"Read-only command.","approved":true}]}';
  const service = new AgentChatService({
    agentConfig: new MockAgentConfig('mock-provider', 'mock-model') as any,
    settings: createMockSettings('mock-provider'),
    logger: mockLogger,
  });

  const result = await service.chatJson('Evaluate command', {
    outputType: {
      type: 'json_schema',
      name: 'shell_auto_approval_evaluation',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { results: { type: 'array' } },
        required: ['results'],
      },
    },
  });

  expect(result).toBe('{"results":[{"reasoning":"Read-only command.","approved":true}]}');
  completionText = 'mock response';
});

it.sequential('chatJson returns finalOutput when available', async () => {
  lastRunRequest = null;

  const service = new AgentChatService({
    agentConfig: new MockAgentConfig('mock-provider', 'mock-model') as any,
    settings: createMockSettings('mock-provider'),
    logger: mockLogger,
  });

  const result = await service.chatJson('Return JSON', {
    outputType: {
      type: 'json_schema',
      name: 'test_output',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
        },
        required: ['ok'],
      },
    },
  });

  expect(result).toBe('mock response');
});
