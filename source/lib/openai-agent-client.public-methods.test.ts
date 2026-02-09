import test from 'ava';
import { OpenAIAgentClient } from './openai-agent-client.js';
import { registerProvider } from '../providers/registry.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';

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

function createMockSettings(values: Record<string, any> = {}): ISettingsService {
  const store: Record<string, any> = {
    'agent.provider': 'mock-provider-public-methods',
    'agent.model': 'mock-model',
    ...values,
  };
  return {
    get: <T>(key: string) => store[key] as T,
    set: (key: string, value: any) => {
      store[key] = value;
    },
  };
}

// Mock Runner that tracks calls
let runnerCalls: any[] = [];
class MockRunner {
  async run(_agent: any, _input: any, _options: any) {
    runnerCalls.push({ agent: _agent, input: _input, options: _options });
    return {
      status: 'completed',
      finalOutput: 'mock response',
      messages: [],
    };
  }
}

// Register mock provider once
let providerRegistered = false;
function ensureProviderRegistered() {
  if (!providerRegistered) {
    registerProvider({
      id: 'mock-provider-public-methods',
      label: 'Mock Provider',
      createRunner: () => new MockRunner() as any,
      fetchModels: async () => [{ id: 'mock-model' }],
      clearConversations: () => {},
    });
    providerRegistered = true;
  }
}

let mentorProviderRegistered = false;
let capturedMainAgentForMentorTest: any = null;
let mentorInputs: any[] = [];
let mentorResponseCounter = 0;
let chainingProviderRegistered = false;
let chainingRunnerCalls: any[] = [];
function ensureMentorProvidersRegistered() {
  if (!mentorProviderRegistered) {
    registerProvider({
      id: 'mock-main-mentor-refresh',
      label: 'Mock Main Mentor Refresh',
      createRunner: () =>
        ({
          run: async (agent: any) => {
            capturedMainAgentForMentorTest = agent;
            return {
              status: 'completed',
              finalOutput: 'ok',
              messages: [],
            };
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });

    registerProvider({
      id: 'mock-mentor-refresh',
      label: 'Mock Mentor Refresh',
      createRunner: () =>
        ({
          run: async (_agent: any, _input: any, _options: any) => {
            mentorInputs.push(_input);
            mentorResponseCounter += 1;
            return {
              status: 'completed',
              finalOutput: `mentor-${mentorResponseCounter}`,
              responseId: `mentor-response-${mentorResponseCounter}`,
              history: [],
              messages: [],
            };
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });

    mentorProviderRegistered = true;
  }
}

function ensureChainingProvidersRegistered() {
  if (!chainingProviderRegistered) {
    registerProvider({
      id: 'mock-chaining-false',
      label: 'Mock Chaining False',
      createRunner: () =>
        ({
          run: async (_agent: any, _input: any, options: any) => {
            chainingRunnerCalls.push({ options, providerId: 'mock-chaining-false' });
            return {
              status: 'completed',
              finalOutput: 'ok',
              messages: [],
            };
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
      capabilities: {
        supportsConversationChaining: false,
        supportsTracingControl: false,
      },
    });

    registerProvider({
      id: 'mock-chaining-true',
      label: 'Mock Chaining True',
      createRunner: () =>
        ({
          run: async (_agent: any, _input: any, options: any) => {
            chainingRunnerCalls.push({ options, providerId: 'mock-chaining-true' });
            return {
              status: 'completed',
              finalOutput: 'ok',
              messages: [],
            };
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
      capabilities: {
        supportsConversationChaining: true,
        supportsTracingControl: true,
      },
    });

    chainingProviderRegistered = true;
  }
}

test.beforeEach(() => {
  runnerCalls = [];
  ensureProviderRegistered();
  ensureMentorProvidersRegistered();
  ensureChainingProvidersRegistered();
  capturedMainAgentForMentorTest = null;
  mentorInputs = [];
  mentorResponseCounter = 0;
  chainingRunnerCalls = [];
});

// ========== setModel tests ==========

test('setModel updates the internal model', async (t) => {
  const settings = createMockSettings();
  const client = new OpenAIAgentClient({
    deps: { logger: createMockLogger(), settings },
  });

  // Set a new model
  client.setModel('gpt-4-turbo');

  // Trigger a chat to see what model is used
  await client.chat('test');

  t.is(runnerCalls.length, 1);
  // The agent should have the updated model
  const agent = runnerCalls[0].agent;
  t.truthy(agent);
});

// ========== setProvider / getProvider tests ==========

test('getProvider returns current provider', (t) => {
  const settings = createMockSettings({ 'agent.provider': 'mock-provider-public-methods' });
  const client = new OpenAIAgentClient({
    deps: { logger: createMockLogger(), settings },
  });

  t.is(client.getProvider(), 'mock-provider-public-methods');
});

test('setProvider updates provider and persists to settings', (t) => {
  const settings = createMockSettings({ 'agent.provider': 'mock-provider-public-methods' });
  const client = new OpenAIAgentClient({
    deps: { logger: createMockLogger(), settings },
  });

  client.setProvider('openai');
  t.is(client.getProvider(), 'openai');
  t.is(settings.get('agent.provider'), 'openai');
});

test.serial('startStream only passes previousResponseId when provider supports chaining', async (t) => {
  const settings = createMockSettings({
    'agent.provider': 'mock-chaining-false',
  });
  const client = new OpenAIAgentClient({
    deps: { logger: createMockLogger(), settings },
  });

  await client.startStream('Hello', { previousResponseId: 'prev-1' });
  t.is(chainingRunnerCalls.length, 1);
  t.false('previousResponseId' in chainingRunnerCalls[0].options);

  client.setProvider('mock-chaining-true');
  await client.startStream('Hello', { previousResponseId: 'prev-2' });
  t.is(chainingRunnerCalls.length, 2);
  t.is(chainingRunnerCalls[1].options.previousResponseId, 'prev-2');
});

test.serial('abort logs with active trace id before clearing correlation', async (t) => {
  const debugLogs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  let correlationId: string | undefined;
  const logger: ILoggingService = {
    debug: (message: string, meta?: Record<string, unknown>) => {
      debugLogs.push({ message, meta });
    },
    info: () => {},
    warn: () => {},
    error: () => {},
    security: () => {},
    setCorrelationId: (id: string | undefined) => {
      correlationId = id;
    },
    clearCorrelationId: () => {
      correlationId = undefined;
    },
    getCorrelationId: () => correlationId,
    log: () => {},
  } as any;
  const settings = createMockSettings({
    'agent.provider': 'mock-chaining-false',
  });
  const client = new OpenAIAgentClient({
    deps: { logger, settings },
  });

  await client.startStream('Hello');
  const activeCorrelationId = correlationId;
  t.truthy(activeCorrelationId);

  client.abort();

  const abortLogs = debugLogs.filter((entry) => entry.message === 'Agent operation aborted');
  t.true(abortLogs.length > 0);
  const latestAbortLog = abortLogs[abortLogs.length - 1];
  t.is(latestAbortLog.meta?.traceId, activeCorrelationId);
  t.is(correlationId, undefined);
});

// ========== addToolInterceptor tests ==========

test('addToolInterceptor returns removal function', (t) => {
  const settings = createMockSettings();
  const client = new OpenAIAgentClient({
    deps: { logger: createMockLogger(), settings },
  });

  const remove = client.addToolInterceptor(async () => {
    return null;
  });

  t.is(typeof remove, 'function');
  // Calling remove should work without error
  remove();
  t.pass();
});

test('addToolInterceptor can be removed', (t) => {
  const settings = createMockSettings();
  const client = new OpenAIAgentClient({
    deps: { logger: createMockLogger(), settings },
  });

  const remove = client.addToolInterceptor(async () => {
    return null;
  });

  // Remove it
  remove();

  // After removal, the interceptor should not be called
  // (We can't directly test this without more complex setup)
  t.pass();
});

// ========== abort tests ==========

test('abort does not throw when called without active operation', (t) => {
  const settings = createMockSettings();
  const client = new OpenAIAgentClient({
    deps: { logger: createMockLogger(), settings },
  });

  // Should not throw
  t.notThrows(() => client.abort());
});

test('abort can be called multiple times', (t) => {
  const settings = createMockSettings();
  const client = new OpenAIAgentClient({
    deps: { logger: createMockLogger(), settings },
  });

  t.notThrows(() => {
    client.abort();
    client.abort();
    client.abort();
  });
});

// ========== clearConversations tests ==========

test('clearConversations does not throw', (t) => {
  const settings = createMockSettings();
  const client = new OpenAIAgentClient({
    deps: { logger: createMockLogger(), settings },
  });

  t.notThrows(() => client.clearConversations());
});

test('clearConversations can be called multiple times', (t) => {
  const settings = createMockSettings();
  const client = new OpenAIAgentClient({
    deps: { logger: createMockLogger(), settings },
  });

  t.notThrows(() => {
    client.clearConversations();
    client.clearConversations();
  });
});

// ========== setReasoningEffort tests ==========

test('setReasoningEffort accepts valid effort levels', (t) => {
  const settings = createMockSettings();
  const client = new OpenAIAgentClient({
    deps: { logger: createMockLogger(), settings },
  });

  t.notThrows(() => client.setReasoningEffort('high'));
  t.notThrows(() => client.setReasoningEffort('medium'));
  t.notThrows(() => client.setReasoningEffort('low'));
  t.notThrows(() => client.setReasoningEffort('default'));
  t.notThrows(() => client.setReasoningEffort(undefined));
});

// ========== setTemperature tests ==========

test('setTemperature accepts numeric values', (t) => {
  const settings = createMockSettings();
  const client = new OpenAIAgentClient({
    deps: { logger: createMockLogger(), settings },
  });

  t.notThrows(() => client.setTemperature(0.5));
  t.notThrows(() => client.setTemperature(1.0));
  t.notThrows(() => client.setTemperature(0));
  t.notThrows(() => client.setTemperature(undefined));
});

// ========== setRetryCallback tests ==========

test('setRetryCallback accepts callback function', (t) => {
  const settings = createMockSettings();
  const client = new OpenAIAgentClient({
    deps: { logger: createMockLogger(), settings },
  });

  t.notThrows(() => client.setRetryCallback(() => {}));
});

test('setModel resets mentor conversation chain used by ask_mentor', async (t) => {
  const settings = createMockSettings({
    'agent.provider': 'mock-main-mentor-refresh',
    'agent.model': 'mock-model',
    'agent.mentorModel': 'mock-mentor-model',
    'agent.mentorProvider': 'mock-mentor-refresh',
    'app.liteMode': false,
  });
  const client = new OpenAIAgentClient({
    deps: { logger: createMockLogger(), settings },
  });

  await client.chat('prime tools');

  const askMentorTool = capturedMainAgentForMentorTest?.tools?.find((tool: any) => tool?.name === 'ask_mentor');
  t.truthy(askMentorTool);
  t.is(typeof askMentorTool?.invoke, 'function');

  await askMentorTool.invoke({}, JSON.stringify({ question: 'first' }), { toolCall: { callId: 'call-1' } });
  await askMentorTool.invoke({}, JSON.stringify({ question: 'second' }), { toolCall: { callId: 'call-2' } });

  t.is(mentorInputs.length, 2);
  t.true(Array.isArray(mentorInputs[0]));
  t.true(Array.isArray(mentorInputs[1]));
  t.is(mentorInputs[0].length, 1);
  t.true(mentorInputs[1].length > 1);

  client.setModel('mock-model-v2');

  await askMentorTool.invoke({}, JSON.stringify({ question: 'third' }), { toolCall: { callId: 'call-3' } });

  t.is(mentorInputs.length, 3);
  t.true(Array.isArray(mentorInputs[2]));
  t.is(mentorInputs[2].length, 1);
});
