import test from 'ava';
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

test.before(() => {
  lastRunAgent = null;
});

test.serial('chat returns extracted response from agent run', async (t) => {
  lastRunAgent = null;

  const service = new AgentChatService({
    agentConfig: new MockAgentConfig('mock-provider', 'mock-model') as any,
    runnerManager: new MockRunnerManager() as any,
    settings: createMockSettings('mock-provider'),
    logger: mockLogger,
  });

  const response = await service.chat('Hello');
  t.is(response, 'mock response');
});

test.serial('chat with temp provider builds temp agent', async (t) => {
  lastRunAgent = null;

  const service = new AgentChatService({
    agentConfig: new MockAgentConfig('mock-provider', 'mock-model') as any,
    runnerManager: new MockRunnerManager() as any,
    settings: createMockSettings('mock-provider'),
    logger: mockLogger,
  });

  await service.chat('Hello', { provider: 'other-provider' });

  t.truthy(lastRunAgent);
  t.is(lastRunAgent.name, 'Chat');
  t.is(lastRunAgent.model, 'mock-model');
});

test.serial('chatJson passes outputType to temp agent', async (t) => {
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

  t.truthy(lastRunAgent);
  t.deepEqual(lastRunAgent.outputType, {
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

test.serial('chatJson returns finalOutput when available', async (t) => {
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

  t.is(result, 'mock response');
});
