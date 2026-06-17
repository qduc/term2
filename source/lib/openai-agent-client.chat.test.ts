import { it, expect, beforeAll } from 'vitest';
import { AgentClient } from './agent-client.js';
import { registerProvider } from '../providers/registry.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';

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

// Mock Runner
let lastRunOptions: any = null;
let lastRunAgent: any = null;
class MockRunner {
  async run(_agent: any, _input: any, _options: any) {
    lastRunAgent = _agent;
    lastRunOptions = _options;
    return {
      status: 'completed',
      messages: [{ role: 'assistant', content: 'Fallback content' }],
      // finalOutput is missing
    };
  }
}

beforeAll(() => {
  registerProvider({
    id: 'mock-provider-chat',
    label: 'Mock Provider Chat',
    createRunner: () => new MockRunner() as any,
    fetchModels: async () => [{ id: 'mock-model' }],
    capabilities: {
      supportsConversationChaining: false,
      supportsTracingControl: false,
    },
  });
  registerProvider({
    id: 'mock-provider-chat-tracing',
    label: 'Mock Provider Chat Tracing',
    createRunner: () => new MockRunner() as any,
    fetchModels: async () => [{ id: 'mock-model' }],
    capabilities: {
      supportsConversationChaining: false,
      supportsTracingControl: true,
    },
  });
});

it.sequential('OpenAIAgentClient.chatJson passes outputType into the temporary Agent', async () => {
  lastRunAgent = null;

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

  expect(lastRunAgent).toBeTruthy();
  expect(lastRunAgent.outputType).toEqual({
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

it.sequential('disables Agents SDK tracing for non-OpenAI providers', async () => {
  lastRunOptions = null;

  const client = new AgentClient({
    deps: {
      logger: mockLogger,
      settings: createMockSettings('mock-provider-chat'),
      sessionContextService: createSessionContextService() as any,
    },
  });

  await client.chat('Hello again');
  expect(lastRunOptions).toBeTruthy();
  expect(lastRunOptions.tracingDisabled).toBe(true);
});

it.sequential('keeps Agents SDK tracing enabled when provider supports it', async () => {
  lastRunOptions = null;

  const client = new AgentClient({
    deps: {
      logger: mockLogger,
      settings: createMockSettings('mock-provider-chat-tracing'),
      sessionContextService: createSessionContextService() as any,
    },
  });

  await client.chat('Hello tracing');
  expect(lastRunOptions).toBeTruthy();
  expect(!!lastRunOptions.tracingDisabled).toBe(false);
});
