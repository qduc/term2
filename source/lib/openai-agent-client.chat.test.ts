import test from 'ava';
import { OpenAIAgentClient } from './openai-agent-client.js';
import { registerProvider } from '../providers/registry.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';

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
class MockRunner {
  async run(_agent: any, _input: any, _options: any) {
    lastRunOptions = _options;
    return {
      status: 'completed',
      messages: [{ role: 'assistant', content: 'Fallback content' }],
      // finalOutput is missing
    };
  }
}

test.before(() => {
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

test.serial('OpenAIAgentClient.chat falls back to messages if finalOutput is missing', async (t) => {
  const client = new OpenAIAgentClient({
    deps: {
      logger: mockLogger,
      settings: createMockSettings('mock-provider-chat'),
    },
  });

  const response = await client.chat('Hello');
  t.is(response, 'Fallback content');
});

test.serial('disables Agents SDK tracing for non-OpenAI providers', async (t) => {
  lastRunOptions = null;

  const client = new OpenAIAgentClient({
    deps: {
      logger: mockLogger,
      settings: createMockSettings('mock-provider-chat'),
    },
  });

  await client.chat('Hello again');
  t.truthy(lastRunOptions);
  t.is(lastRunOptions.tracingDisabled, true);
});

test.serial('keeps Agents SDK tracing enabled when provider supports it', async (t) => {
  lastRunOptions = null;

  const client = new OpenAIAgentClient({
    deps: {
      logger: mockLogger,
      settings: createMockSettings('mock-provider-chat-tracing'),
    },
  });

  await client.chat('Hello tracing');
  t.truthy(lastRunOptions);
  t.false(!!lastRunOptions.tracingDisabled);
});
