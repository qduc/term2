import { it, expect, beforeAll } from 'vitest';
import { AgentClient as ProductionAgentClient } from './agent-client.js';
import { registerProvider } from '../providers/registry.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';

class AgentClient extends ProductionAgentClient {
  constructor(options: Omit<ConstructorParameters<typeof ProductionAgentClient>[0], 'toolOwnership'>) {
    super({ ...options, toolOwnership: new ToolOwnershipRegistry() });
  }
}

const createSessionContextService = () => ({
  runWithContext: <T>(_context: any, fn: () => T) => fn(),
  getContext: () => null,
});

// Mock Logger
const mockLogger: ILoggingService = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  setCorrelationId: () => {},
  clearCorrelationId: () => {},
  log: () => {},
} as any;

const createMockSettings = (providerId: string): ISettingsService =>
  ({
    get: (key: string) => {
      if (key === 'agent.provider') return providerId;
      if (key === 'agent.model') return 'mock-model';
      return undefined;
    },
    set: () => {},
    onChange: () => {},
  } as any);

let lastRunRequest: any = null;
function createChatModel(): any {
  return {
    async *stream(request: any) {
      lastRunRequest = request;
      yield {
        type: 'completion',
        responseId: 'chat-response',
        output: [{ type: 'message', content: [{ type: 'text', text: 'Fallback content' }] }],
      };
    },
  };
}

beforeAll(() => {
  registerProvider({
    id: 'mock-provider-chat',
    label: 'Mock Provider Chat',
    createStreamedModel: () => createChatModel(),
    fetchModels: async () => [{ id: 'mock-model' }],
  });
  registerProvider({
    id: 'mock-provider-chat-tracing',
    label: 'Mock Provider Chat Tracing',
    createStreamedModel: () => createChatModel(),
    fetchModels: async () => [{ id: 'mock-model' }],
  });
});

it.sequential('OpenAIAgentClient.chatJson passes outputType into the temporary Agent', async () => {
  lastRunRequest = null;

  const client = new AgentClient({
    deps: {
      logger: mockLogger,
      settings: createMockSettings('mock-provider-chat'),
      sessionContextService: createSessionContextService() as any,
    },
  });

  await client.chatJson('Return JSON', {
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

it.sequential('OpenAIAgentClient.chat falls back to messages if finalOutput is missing', async () => {
  const client = new AgentClient({
    deps: {
      logger: mockLogger,
      settings: createMockSettings('mock-provider-chat'),
      sessionContextService: createSessionContextService() as any,
    },
  });

  const response = await client.chat('Hello');
  expect(response).toBe('Fallback content');
});

it.sequential('passes direct application requests to non-tracing providers', async () => {
  lastRunRequest = null;

  const client = new AgentClient({
    deps: {
      logger: mockLogger,
      settings: createMockSettings('mock-provider-chat'),
      sessionContextService: createSessionContextService() as any,
    },
  });

  await client.chat('Hello again');
  expect(lastRunRequest).toBeTruthy();
  expect(lastRunRequest.input).toBeTruthy();
});

it.sequential('passes direct application requests to tracing-capable providers', async () => {
  lastRunRequest = null;

  const client = new AgentClient({
    deps: {
      logger: mockLogger,
      settings: createMockSettings('mock-provider-chat-tracing'),
      sessionContextService: createSessionContextService() as any,
    },
  });

  await client.chat('Hello tracing');
  expect(lastRunRequest).toBeTruthy();
  expect(lastRunRequest.input).toBeTruthy();
});
