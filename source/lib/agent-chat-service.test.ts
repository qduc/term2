import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { AgentChatService } from './agent-chat-service.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';

// Module-level capture variable used by the mock runner
let lastRunAgent: any = null;

class MockRunner {
  async run(_agent: any, _input: any, _options: any) {
    lastRunAgent = _agent;
    return {
      status: 'completed',
      finalOutput: 'mock response',
      messages: [],
    };
  }
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

class MockRunnerManager {
  getOrCreateRunner(_providerId: string): any {
    return new MockRunner() as any;
  }
}

beforeAll(() => {
  lastRunAgent = null;
});

it.sequential('chat returns extracted response from agent run', async () => {
  lastRunAgent = null;

  const service = new AgentChatService({
    agentConfig: new MockAgentConfig('mock-provider', 'mock-model') as any,
    runnerManager: new MockRunnerManager() as any,
    settings: createMockSettings('mock-provider'),
    logger: mockLogger,
  });

  const response = await service.chat('Hello');
  expect(response).toBe('mock response');
});

it.sequential('chat with temp provider builds temp agent', async () => {
  lastRunAgent = null;

  const service = new AgentChatService({
    agentConfig: new MockAgentConfig('mock-provider', 'mock-model') as any,
    runnerManager: new MockRunnerManager() as any,
    settings: createMockSettings('mock-provider'),
    logger: mockLogger,
  });

  await service.chat('Hello', { provider: 'other-provider' });

  expect(lastRunAgent).toBeTruthy();
  expect(lastRunAgent.name).toBe('Chat');
  expect(lastRunAgent.model).toBe('mock-model');
});

it.sequential('chatJson passes outputType to temp agent', async () => {
  lastRunAgent = null;

  const service = new AgentChatService({
    agentConfig: new MockAgentConfig('mock-provider', 'mock-model') as any,
    runnerManager: new MockRunnerManager() as any,
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

it.sequential('chatJson returns finalOutput when available', async () => {
  lastRunAgent = null;

  const service = new AgentChatService({
    agentConfig: new MockAgentConfig('mock-provider', 'mock-model') as any,
    runnerManager: new MockRunnerManager() as any,
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
