import { it, expect, beforeEach, vi } from 'vitest';
import { AgentClient } from './agent-client.js';
import { registerProvider } from '../providers/registry.js';
import { SubagentBridge } from './subagent-bridge.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';

const createSessionContextService = () => ({
  runWithContext: <T>(_context: any, fn: () => T) => fn(),
  getContext: () => null,
});

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
let mentorInputsAltProvider: any[] = [];
let mentorResponseCounter = 0;
let chainingProviderRegistered = false;
let chainingRunnerCalls: any[] = [];
let codexProviderRegistered = false;
let codexRunnerCalls: any[] = [];
let openaiProviderRegistered = false;
let openaiRunnerCalls: any[] = [];
let failingProviderRegistered = false;
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

    registerProvider({
      id: 'mock-mentor-refresh-alt',
      label: 'Mock Mentor Refresh Alt',
      createRunner: () =>
        ({
          run: async (_agent: any, _input: any, _options: any) => {
            mentorInputsAltProvider.push(_input);
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
            chainingRunnerCalls.push({ input: _input, options, providerId: 'mock-chaining-false' });
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
            chainingRunnerCalls.push({ input: _input, options, providerId: 'mock-chaining-true' });
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

function ensureCodexProviderRegistered() {
  if (!codexProviderRegistered) {
    registerProvider(
      {
        id: 'codex',
        label: 'Mock Codex',
        createRunner: () =>
          ({
            run: async (agent: any, _input: any, options: any) => {
              codexRunnerCalls.push({ agent, options });
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
          supportsPromptCacheKey: true,
        },
      },
      { allowOverride: true },
    );

    codexProviderRegistered = true;
  }
}

function ensureOpenAIProviderRegistered() {
  if (!openaiProviderRegistered) {
    registerProvider(
      {
        id: 'openai',
        label: 'Mock OpenAI',
        createRunner: () =>
          ({
            run: async (agent: any, _input: any, options: any) => {
              openaiRunnerCalls.push({ agent, options });
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
          supportsPromptCacheKey: true,
        },
      },
      { allowOverride: true },
    );

    openaiProviderRegistered = true;
  }
}

function ensureFailingProviderRegistered() {
  if (!failingProviderRegistered) {
    registerProvider({
      id: 'mock-missing-creds',
      label: 'Mock Missing Creds',
      createRunner: () => {
        throw new Error('Missing credentials');
      },
      fetchModels: async () => [{ id: 'mock-model' }],
      capabilities: {
        supportsConversationChaining: false,
        supportsTracingControl: true,
      },
    });

    failingProviderRegistered = true;
  }
}

beforeEach(() => {
  runnerCalls = [];
  ensureProviderRegistered();
  ensureMentorProvidersRegistered();
  ensureChainingProvidersRegistered();
  ensureCodexProviderRegistered();
  ensureOpenAIProviderRegistered();
  ensureFailingProviderRegistered();
  capturedMainAgentForMentorTest = null;
  mentorInputs = [];
  mentorInputsAltProvider = [];
  mentorResponseCounter = 0;
  chainingRunnerCalls = [];
  codexRunnerCalls = [];
  openaiRunnerCalls = [];
});

// ========== setModel tests ==========

it.sequential('setModel updates the internal model', async () => {
  const settings = createMockSettings();
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  // Set a new model
  client.setModel('gpt-4-turbo');

  // Trigger a chat to see what model is used
  await client.chat('test');

  expect(runnerCalls.length).toBe(1);
  // The agent should have the updated model
  const agent = runnerCalls[0].agent;
  expect(agent).toBeTruthy();
});

// ========== setProvider / getProvider tests ==========

it.sequential('getProvider returns current provider', () => {
  const settings = createMockSettings({ 'agent.provider': 'mock-provider-public-methods' });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  expect(client.getProvider()).toBe('mock-provider-public-methods');
});

it.sequential('setProvider updates provider and persists to settings', () => {
  const settings = createMockSettings({ 'agent.provider': 'mock-provider-public-methods' });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  client.setProvider('openai');
  expect(client.getProvider()).toBe('openai');
  expect(settings.get('agent.provider')).toBe('openai');
});

it.sequential('setProvider does not initialize provider credentials eagerly', async () => {
  const settings = createMockSettings({ 'agent.provider': 'mock-provider-public-methods' });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  client.setProvider('mock-missing-creds');

  expect(client.getProvider()).toBe('mock-missing-creds');
  expect(settings.get('agent.provider')).toBe('mock-missing-creds');

  await expect(async () => client.chat('test')).rejects.toThrow('Missing credentials');
});

it.sequential('startStream only passes previousResponseId when provider supports chaining', async () => {
  const settings = createMockSettings({
    'agent.provider': 'mock-chaining-false',
  });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  await client.startStream('Hello', { previousResponseId: 'prev-1' });
  expect(chainingRunnerCalls.length).toBe(1);
  expect('previousResponseId' in chainingRunnerCalls[0].options).toBe(false);

  client.setProvider('mock-chaining-true');
  await client.startStream('Hello', { previousResponseId: 'prev-2' });
  expect(chainingRunnerCalls.length).toBe(2);
  expect(chainingRunnerCalls[1].options.previousResponseId).toBe('prev-2');
});

it.sequential(
  'continueRunStream filters replayed history to delta input when chaining from previousResponseId',
  async () => {
    const settings = createMockSettings({
      'agent.provider': 'mock-chaining-true',
    });
    const client = new AgentClient({
      deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
    });

    const state = {
      _context: { context: { turnCount: 0 } },
      _generatedItems: [
        { rawItem: { type: 'function_call', callId: 'call-read', name: 'read_file', arguments: '{}' } },
        { rawItem: { type: 'function_call_output', callId: 'call-read', output: 'done' } },
      ],
    };

    await client.continueRunStream(state as any, { previousResponseId: 'resp-prev' });

    expect(chainingRunnerCalls.length).toBe(1);
    const call = chainingRunnerCalls[0];
    expect(call.input).toBe(state);
    expect(call.options.previousResponseId).toBe('resp-prev');

    const filtered = call.options.callModelInputFilter({
      context: { turnCount: 0 },
      modelData: {
        input: [
          { role: 'user', type: 'message', content: 'inspect file' },
          { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'I will inspect it.' }] },
          { type: 'function_call', callId: 'call-read', name: 'read_file', arguments: '{}' },
          { type: 'function_call_output', callId: 'call-read', output: 'done' },
        ],
        instructions: 'system',
      },
    });

    expect(filtered.input).toEqual([{ type: 'function_call_output', callId: 'call-read', output: 'done' }]);
    expect(filtered.instructions).toBe('system');
  },
);

it.sequential(
  'continueRunStream filters replayed history to delta input with function_call_output_result and tool_call_output_item',
  async () => {
    const settings = createMockSettings({
      'agent.provider': 'mock-chaining-true',
    });
    const client = new AgentClient({
      deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
    });

    await client.continueRunStream({ _context: { context: { turnCount: 0 } } } as any, {
      previousResponseId: 'resp-prev',
    });

    const filtered = chainingRunnerCalls[0].options.callModelInputFilter({
      context: { turnCount: 0 },
      modelData: {
        input: [
          { role: 'user', type: 'message', content: 'inspect file' },
          { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'I will inspect it.' }] },
          { type: 'function_call', callId: 'call-read', name: 'read_file', arguments: '{}' },
          { type: 'function_call_output_result', callId: 'call-read', output: 'done' },
          { type: 'tool_call_output_item', callId: 'call-read', output: 'done' },
        ],
        instructions: 'system',
      },
    });

    expect(filtered.input).toEqual([
      { type: 'function_call_output_result', callId: 'call-read', output: 'done' },
      { type: 'tool_call_output_item', callId: 'call-read', output: 'done' },
    ]);
  },
);

it.sequential(
  'continueRunStream keeps the latest user item when chained model input replays full history',
  async () => {
    const settings = createMockSettings({
      'agent.provider': 'mock-chaining-true',
    });
    const client = new AgentClient({
      deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
    });

    await client.continueRunStream({ _context: { context: { turnCount: 0 } } } as any, {
      previousResponseId: 'resp-prev',
    });

    const filtered = chainingRunnerCalls[0].options.callModelInputFilter({
      context: { turnCount: 0 },
      modelData: {
        input: [
          { role: 'user', type: 'message', content: 'first' },
          { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'first response' }] },
          { role: 'user', type: 'message', content: 'second' },
        ],
        instructions: 'system',
      },
    });

    expect(filtered.input).toEqual([{ role: 'user', type: 'message', content: 'second' }]);
  },
);

it.sequential('startStream filters replayed history to delta input when chaining from previousResponseId', async () => {
  const settings = createMockSettings({
    'agent.provider': 'mock-chaining-true',
  });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  await client.startStream('inspect file', { previousResponseId: 'resp-prev' });

  expect(chainingRunnerCalls.length).toBe(1);
  const call = chainingRunnerCalls[0];
  expect(call.options.previousResponseId).toBe('resp-prev');

  const filtered = call.options.callModelInputFilter({
    context: { turnCount: 0 },
    modelData: {
      input: [
        { role: 'user', type: 'message', content: 'inspect file' },
        { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'I will inspect it.' }] },
        { type: 'function_call', callId: 'call-read', name: 'read_file', arguments: '{}' },
        { type: 'function_call_output', callId: 'call-read', output: 'done' },
      ],
      instructions: 'system',
    },
  });

  expect(filtered.input).toEqual([{ type: 'function_call_output', callId: 'call-read', output: 'done' }]);
  expect(filtered.instructions).toBe('system');
});

it.sequential('continueRunStream keeps only expected approved tool outputs when chaining', async () => {
  const settings = createMockSettings({
    'agent.provider': 'mock-chaining-true',
  });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  await client.continueRunStream({ _context: { context: { turnCount: 0 } } } as any, {
    previousResponseId: 'resp-prev',
    toolResultCallIds: ['call-current'],
  });

  const filtered = chainingRunnerCalls[0].options.callModelInputFilter({
    context: { turnCount: 0 },
    modelData: {
      input: [
        { type: 'function_call_output', callId: 'call-old-1', output: 'old one' },
        { type: 'function_call_output', call_id: 'call-old-2', output: 'old two' },
        { type: 'function_call_output', callId: 'call-current', output: 'current' },
      ],
      instructions: 'system',
    },
  });

  expect(filtered.input).toEqual([{ type: 'function_call_output', callId: 'call-current', output: 'current' }]);
});

it.sequential('continueRunStream warns when chained delta input item count spikes', async () => {
  const warnings: any[] = [];
  const logger = {
    ...createMockLogger(),
    warn: (message: string, meta: any) => warnings.push({ message, meta }),
  };
  const settings = createMockSettings({
    'agent.provider': 'mock-chaining-true',
  });
  const client = new AgentClient({
    deps: { logger, settings, sessionContextService: createSessionContextService() as any },
  });

  await client.continueRunStream({ _context: { context: { turnCount: 0 } } } as any, {
    previousResponseId: 'resp-prev',
  });
  const filter = chainingRunnerCalls[0].options.callModelInputFilter;
  filter({
    context: { turnCount: 0 },
    modelData: {
      input: [
        { type: 'function_call_output', callId: 'call-1', output: 'one' },
        { type: 'function_call_output', callId: 'call-2', output: 'two' },
        { type: 'function_call_output', callId: 'call-3', output: 'three' },
      ],
    },
  });
  filter({
    context: { turnCount: 1 },
    modelData: {
      input: Array.from({ length: 23 }, (_, index) => ({
        type: 'function_call_output',
        callId: `call-${index}`,
        output: `output-${index}`,
      })),
    },
  });

  const warning = warnings.find((entry) => entry.meta?.eventType === 'provider.chained_delta_input_spike');
  expect(warning).toBeTruthy();
  expect(warning.meta.previousInputItems).toBe(3);
  expect(warning.meta.inputItems).toBe(23);
});

it.sequential('continueRunStream filters and keeps user message even with custom type', async () => {
  const settings = createMockSettings({
    'agent.provider': 'mock-chaining-true',
  });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  await client.continueRunStream({ _context: { context: { turnCount: 0 } } } as any, {
    previousResponseId: 'resp-prev',
  });

  const filtered = chainingRunnerCalls[0].options.callModelInputFilter({
    context: { turnCount: 0 },
    modelData: {
      input: [
        { role: 'user', type: 'message', content: 'first' },
        { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'first response' }] },
        { role: 'user', type: 'custom_input_type', content: 'second' },
      ],
      instructions: 'system',
    },
  });

  expect(filtered.input).toEqual([{ role: 'user', type: 'custom_input_type', content: 'second' }]);
});

// ========== Characterization tests for stream lifecycle ==========

it.sequential('startStream with chaining and input filtering', async () => {
  const settings = createMockSettings({
    'agent.provider': 'mock-chaining-true',
  });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  await client.startStream('Hello', { previousResponseId: 'prev-1' });

  expect(chainingRunnerCalls.length).toBe(1);
  expect(chainingRunnerCalls[0].options.previousResponseId).toBe('prev-1');
  expect(typeof chainingRunnerCalls[0].options.callModelInputFilter).toBe('function');
});

it.sequential('continueRunStream resuming from a RunState with chaining', async () => {
  const settings = createMockSettings({
    'agent.provider': 'mock-chaining-true',
  });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  const state = { _context: { context: { turnCount: 0 } }, _generatedItems: [] };

  await client.continueRunStream(state as any, { previousResponseId: 'resp-prev' });

  expect(chainingRunnerCalls.length).toBe(1);
  expect(chainingRunnerCalls[0].input).toBe(state);
  expect(chainingRunnerCalls[0].options.previousResponseId).toBe('resp-prev');
  expect(chainingRunnerCalls[0].options.stream).toBe(true);
  expect(typeof chainingRunnerCalls[0].options.callModelInputFilter).toBe('function');
});

it.sequential('abort during an active startStream', async () => {
  let capturedSignal: AbortSignal | undefined;
  const testProviderId = 'mock-abort-active-stream';

  registerProvider({
    id: testProviderId,
    label: 'Mock Abort Active Stream',
    createRunner: () =>
      ({
        run: async (_agent: any, _input: any, options: any) => {
          capturedSignal = options.signal;
          // Wait until aborted before resolving
          await new Promise<void>((resolve) => {
            options.signal.addEventListener('abort', () => resolve());
          });
          return { status: 'completed', finalOutput: 'done', messages: [] };
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  let correlationId: string | undefined;
  const logger: ILoggingService = {
    debug: () => {},
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
    'agent.provider': testProviderId,
    'agent.model': 'mock-model',
  });
  const client = new AgentClient({
    deps: { logger, settings, sessionContextService: createSessionContextService() as any },
  });

  // Start stream - runner will wait until aborted
  const streamPromise = client.startStream('Hello');

  // capturedSignal is set synchronously before startStream awaits the runner
  expect(correlationId).toBeTruthy();
  expect(capturedSignal).toBeTruthy();
  expect(capturedSignal!.aborted).toBe(false);

  // Abort
  client.abort();

  await streamPromise;

  expect(capturedSignal!.aborted).toBe(true);
  expect(correlationId).toBeFalsy();
});

it.sequential('clearConversations resets chained delta state', async () => {
  const warnings: any[] = [];
  const logger = {
    ...createMockLogger(),
    warn: (message: string, meta: any) => warnings.push({ message, meta }),
  };
  const settings = createMockSettings({
    'agent.provider': 'mock-chaining-true',
    'agent.model': 'mock-model',
  });
  const client = new AgentClient({
    deps: { logger, settings, sessionContextService: createSessionContextService() as any },
  });

  // First stream with chaining - establishes #lastChainedDeltaInputItems
  await client.startStream('Hello', { previousResponseId: 'prev-1' });
  chainingRunnerCalls[0].options.callModelInputFilter({
    context: { turnCount: 0 },
    modelData: { input: [{ type: 'function_call_output', callId: 'call-1', output: 'one' }] },
  });

  // Clear conversations - should reset #lastChainedDeltaInputItems to null
  client.clearConversations();

  // Start another stream with chaining after clear
  await client.startStream('World', { previousResponseId: 'prev-2' });
  chainingRunnerCalls[1].options.callModelInputFilter({
    context: { turnCount: 0 },
    modelData: {
      input: Array.from({ length: 23 }, (_, i) => ({
        type: 'function_call_output',
        callId: `call-${i}`,
        output: `output-${i}`,
      })),
    },
  });

  // After clearConversations, #lastChainedDeltaInputItems is null,
  // so a large jump should NOT trigger the spike warning
  const spikeWarnings = warnings.filter((w) => w.meta?.eventType === 'provider.chained_delta_input_spike');
  expect(spikeWarnings.length, 'should not warn about spike after clearConversations resets state').toBe(0);
});

it.sequential('chat and chatJson with temp provider/reasoning-effort overrides', async () => {
  const chatRunnerCalls: any[] = [];
  registerProvider({
    id: 'mock-chat-override-test',
    label: 'Mock Chat Override Test',
    createRunner: () =>
      ({
        run: async (agent: any, _input: any, _options: any) => {
          chatRunnerCalls.push({ agent, input: _input, options: _options });
          return { status: 'completed', finalOutput: 'mock chat response', messages: [] };
        },
      } as any),
    fetchModels: async () => [{ id: 'chat-override-model' }],
  });

  const settings = createMockSettings({
    'agent.provider': 'mock-provider-public-methods',
    'agent.model': 'default-model',
  });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  // Call chat with provider, model, and reasoningEffort override
  const chatResult = await client.chat('Hello', {
    provider: 'mock-chat-override-test',
    model: 'chat-override-model',
    reasoningEffort: 'high',
  });

  expect(chatResult).toBe('mock chat response');
  expect(chatRunnerCalls.length, 'chat should use the override provider').toBe(1);
  expect(chatRunnerCalls[0].agent.name).toBe('Chat');
  expect(chatRunnerCalls[0].agent.model).toBe('chat-override-model');
  expect(chatRunnerCalls[0].agent.modelSettings?.reasoning?.effort).toBe('high');
  expect(chatRunnerCalls[0].input).toBe('Hello');
  expect(chatRunnerCalls[0].options.stream).toBe(false);

  // The default provider should not have been used
  expect(runnerCalls.length, 'default provider runner should not be called for chat with override').toBe(0);

  // Now call chatJson with different reasoningEffort
  const chatJsonResult = await client.chatJson('Hello structured', {
    provider: 'mock-chat-override-test',
    model: 'chat-override-model',
    reasoningEffort: 'medium',
    outputType: {
      type: 'json_schema',
      name: 'test_result',
      strict: true,
      schema: {
        type: 'object',
        properties: { result: { type: 'string' } },
        required: ['result'],
        additionalProperties: false,
      },
    },
  });

  expect(chatJsonResult).toBe('mock chat response');
  expect(chatRunnerCalls.length, 'chatJson should use the override provider').toBe(2);
  expect(chatRunnerCalls[1].agent.name).toBe('Chat');
  expect(chatRunnerCalls[1].agent.model).toBe('chat-override-model');
  expect(chatRunnerCalls[1].agent.modelSettings?.reasoning?.effort).toBe('medium');
  expect(chatRunnerCalls[1].input).toBe('Hello structured');
  expect(chatRunnerCalls[1].options.stream).toBe(false);
  expect(chatRunnerCalls[1].agent.outputType).toBeTruthy();

  // Default provider still not called
  expect(runnerCalls.length, 'default provider runner should still not be called').toBe(0);
});

it.sequential('codex startStream puts prompt_cache_key on agent modelSettings, not run options', async () => {
  const settings = createMockSettings({
    'agent.provider': 'codex',
  });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  await client.startStream('Hello', { sessionId: 'session-123' });

  expect(codexRunnerCalls.length).toBe(1);
  expect(codexRunnerCalls[0].agent.modelSettings.prompt_cache_key).toBe('session-123');
  expect(codexRunnerCalls[0].options.context.sessionId).toBe('session-123');
  expect('modelSettings' in codexRunnerCalls[0].options).toBe(false);
});

it.sequential('openai startStream puts prompt_cache_key on agent modelSettings, not run options', async () => {
  const settings = createMockSettings({
    'agent.provider': 'openai',
  });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  await client.startStream('Hello', { sessionId: 'session-456' });

  expect(openaiRunnerCalls.length).toBe(1);
  expect(openaiRunnerCalls[0].agent.modelSettings.prompt_cache_key).toBe('session-456');
  expect('modelSettings' in openaiRunnerCalls[0].options).toBe(false);
});

it.sequential('startStream omits prompt_cache_key when provider does not support it', async () => {
  const settings = createMockSettings({
    'agent.provider': 'mock-provider-public-methods',
  });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  await client.startStream('Hello', { sessionId: 'session-789' });

  expect(runnerCalls.length).toBe(1);
  expect(runnerCalls[0].agent.modelSettings?.prompt_cache_key).toBeFalsy();
});

it.sequential('abort logs with active trace id before clearing correlation', async () => {
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
  const client = new AgentClient({
    deps: { logger, settings, sessionContextService: createSessionContextService() as any },
  });

  await client.startStream('Hello');
  const activeCorrelationId = correlationId;
  expect(activeCorrelationId).toBeTruthy();

  client.abort();

  const abortLogs = debugLogs.filter((entry) => entry.message === 'Agent operation aborted');
  expect(abortLogs.length > 0).toBe(true);
  const latestAbortLog = abortLogs[abortLogs.length - 1];
  expect(latestAbortLog.meta?.traceId).toBe(activeCorrelationId);
  expect(correlationId).toBe(undefined);
});

// ========== addToolInterceptor tests ==========

it.sequential('addToolInterceptor returns removal function', () => {
  const settings = createMockSettings();
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  const remove = client.addToolInterceptor(async () => {
    return null;
  });

  expect(typeof remove).toBe('function');
  // Calling remove should work without error
  remove();
  expect(true).toBe(true);
});

it.sequential('addToolInterceptor can be removed', () => {
  const settings = createMockSettings();
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  const remove = client.addToolInterceptor(async () => {
    return null;
  });

  // Remove it
  remove();

  // After removal, the interceptor should not be called
  // (We can't directly test this without more complex setup)
});

// ========== abort tests ==========

it.sequential('abort does not throw when called without active operation', () => {
  const settings = createMockSettings();
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  // Should not throw
  expect(() => client.abort()).not.toThrow();
});

it.sequential('abort can be called multiple times', () => {
  const settings = createMockSettings();
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  expect(() => {
    client.abort();
    client.abort();
    client.abort();
  }).not.toThrow();
});

// ========== clearConversations tests ==========

it.sequential('clearConversations does not throw', () => {
  const settings = createMockSettings();
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  expect(() => client.clearConversations()).not.toThrow();
});

it.sequential('clearConversations can be called multiple times', () => {
  const settings = createMockSettings();
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  expect(() => {
    client.clearConversations();
    client.clearConversations();
  }).not.toThrow();
});

// ========== setReasoningEffort tests ==========

it.sequential('setReasoningEffort accepts valid effort levels', () => {
  const settings = createMockSettings();
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  expect(() => client.setReasoningEffort('high')).not.toThrow();
  expect(() => client.setReasoningEffort('medium')).not.toThrow();
  expect(() => client.setReasoningEffort('low')).not.toThrow();
  expect(() => client.setReasoningEffort('default')).not.toThrow();
  expect(() => client.setReasoningEffort(undefined)).not.toThrow();
});

// ========== setTemperature tests ==========

it.sequential('setTemperature accepts numeric values', () => {
  const settings = createMockSettings();
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  expect(() => client.setTemperature(0.5)).not.toThrow();
  expect(() => client.setTemperature(1.0)).not.toThrow();
  expect(() => client.setTemperature(0)).not.toThrow();
  expect(() => client.setTemperature(undefined)).not.toThrow();
});

// ========== setRetryCallback tests ==========

it.sequential('setRetryCallback accepts callback function', () => {
  const settings = createMockSettings();
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  expect(() => client.setRetryCallback(() => {})).not.toThrow();
});

it.sequential('setRetryCallback is forwarded to the provider runner', async () => {
  const providerId = 'mock-retry-callback-provider';
  let providerRetryHook: (() => void) | undefined;
  let retryCount = 0;

  registerProvider({
    id: providerId,
    label: 'Mock Retry Callback Provider',
    createRunner: (deps) => {
      providerRetryHook = deps.onRetry;
      return {
        run: async () => {
          deps.onRetry?.();
          return {
            status: 'completed',
            finalOutput: 'mock response',
            messages: [],
          };
        },
      } as any;
    },
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const settings = createMockSettings({
    'agent.provider': providerId,
    'agent.model': 'mock-model',
  });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  client.setRetryCallback(() => {
    retryCount += 1;
  });

  await client.chat('trigger retry hook');

  expect(providerRetryHook).toBeTruthy();
  expect(retryCount).toBe(1);
});

it.sequential('setAskUserAnswer stores and consumes answers by call id', () => {
  const settings = createMockSettings();
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  client.setAskUserAnswer('call-1', 'Use the existing config');

  expect(client.getAskUserAnswer('call-1')).toBe('Use the existing config');
  expect(client.getAskUserAnswer('call-1')).toBeUndefined();
});

it.sequential('getAskUserAnswer returns undefined for unknown call ids', () => {
  const settings = createMockSettings();
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  expect(client.getAskUserAnswer('missing-call')).toBeUndefined();
  expect(client.getAskUserAnswer()).toBeUndefined();
});

it.sequential('ask_user tool executes using the stored approval answer', async () => {
  const settings = createMockSettings({
    'agent.provider': 'mock-main-mentor-refresh',
    'agent.model': 'mock-model',
    'app.liteMode': false,
  });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  await client.chat('prime tools');

  const askUserTool = capturedMainAgentForMentorTest?.tools?.find((tool: any) => tool?.name === 'ask_user');
  expect(askUserTool).toBeTruthy();
  expect(typeof askUserTool?.invoke).toBe('function');

  client.setAskUserAnswer('call-bridge', 'Use the safe option');

  const result = await askUserTool.invoke(
    {},
    JSON.stringify({
      questions: [
        {
          question: 'Which option should I use?',
          options: [
            { label: 'Use the safe option', description: 'Default behavior' },
            { label: 'Ask later', description: 'Defer the decision' },
          ],
        },
      ],
    }),
    { toolCall: { callId: 'call-bridge' } },
  );

  expect(result).toBe('Use the safe option');
  expect(client.getAskUserAnswer('call-bridge')).toBeUndefined();
});

it.sequential('setModel resets mentor conversation chain used by ask_mentor', async () => {
  const settings = createMockSettings({
    'agent.provider': 'mock-main-mentor-refresh',
    'agent.model': 'mock-model',
    'agent.mentorModel': 'mock-mentor-model',
    'agent.mentorProvider': 'mock-mentor-refresh',
    'app.liteMode': false,
  });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  await client.chat('prime tools');

  const askMentorTool = capturedMainAgentForMentorTest?.tools?.find((tool: any) => tool?.name === 'ask_mentor');
  expect(askMentorTool).toBeTruthy();
  expect(typeof askMentorTool?.invoke).toBe('function');

  await askMentorTool.invoke({}, JSON.stringify({ question: 'first' }), { toolCall: { callId: 'call-1' } });
  await askMentorTool.invoke({}, JSON.stringify({ question: 'second' }), { toolCall: { callId: 'call-2' } });

  expect(mentorInputs.length).toBe(2);
  expect(Array.isArray(mentorInputs[0])).toBe(true);
  expect(Array.isArray(mentorInputs[1])).toBe(true);
  expect(mentorInputs[0].length).toBe(1);
  expect(mentorInputs[1].length > 1).toBe(true);

  client.setModel('mock-model-v2');

  await askMentorTool.invoke({}, JSON.stringify({ question: 'third' }), { toolCall: { callId: 'call-3' } });

  expect(mentorInputs.length).toBe(3);
  expect(Array.isArray(mentorInputs[2])).toBe(true);
  expect(mentorInputs[2].length).toBe(1);
});

it.sequential('ask_mentor resets conversation chain when mentor provider changes', async () => {
  const settings = createMockSettings({
    'agent.provider': 'mock-main-mentor-refresh',
    'agent.model': 'mock-model',
    'agent.mentorModel': 'mock-mentor-model',
    'agent.mentorProvider': 'mock-mentor-refresh',
    'app.liteMode': false,
  });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  await client.chat('prime tools');

  const askMentorTool = capturedMainAgentForMentorTest?.tools?.find((tool: any) => tool?.name === 'ask_mentor');
  expect(askMentorTool).toBeTruthy();
  expect(typeof askMentorTool?.invoke).toBe('function');

  await askMentorTool.invoke({}, JSON.stringify({ question: 'first' }), { toolCall: { callId: 'call-1' } });
  await askMentorTool.invoke({}, JSON.stringify({ question: 'second' }), { toolCall: { callId: 'call-2' } });

  expect(mentorInputs.length).toBe(2);
  expect(Array.isArray(mentorInputs[0])).toBe(true);
  expect(Array.isArray(mentorInputs[1])).toBe(true);
  expect(mentorInputs[0].length).toBe(1);
  expect(mentorInputs[1].length > 1).toBe(true);

  settings.set('agent.mentorProvider', 'mock-mentor-refresh-alt');

  await askMentorTool.invoke({}, JSON.stringify({ question: 'third' }), { toolCall: { callId: 'call-3' } });

  expect(mentorInputsAltProvider.length).toBe(1);
  expect(Array.isArray(mentorInputsAltProvider[0])).toBe(true);
  expect(mentorInputsAltProvider[0].length).toBe(1);
});

it.sequential('setSubagentEventSink defers cleanup to null when subagents are active', async () => {
  let subagentPromiseResolve: (() => void) | null = null;
  registerProvider({
    id: 'mock-deferred-sink-provider',
    label: 'Mock Deferred Sink Provider',
    createRunner: () =>
      ({
        run: async () => {
          await new Promise<void>((resolve) => {
            subagentPromiseResolve = resolve;
          });
          return {
            status: 'completed',
            finalOutput: 'mentor response',
            history: [],
            messages: [],
          };
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const settings = createMockSettings({
    'agent.provider': 'mock-main-mentor-refresh',
    'agent.model': 'mock-model',
    'agent.mentorModel': 'mock-mentor-model',
    'agent.mentorProvider': 'mock-deferred-sink-provider',
    'app.liteMode': false,
  });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  await client.chat('prime tools');

  const askMentorTool = capturedMainAgentForMentorTest?.tools?.find((tool: any) => tool?.name === 'ask_mentor');
  expect(askMentorTool).toBeTruthy();

  let eventCount = 0;
  const dummySink = () => {
    eventCount++;
  };

  client.setSubagentEventSink(dummySink);

  // Start the run
  const invokePromise = askMentorTool.invoke({}, JSON.stringify({ question: 'help me' }), {
    toolCall: { callId: 'call-1' },
  });

  // Yield to event loop to allow the runner's async function to execute and populate subagentPromiseResolve
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Call setSubagentEventSink(null) while the run is active
  client.setSubagentEventSink(null);

  // Resolve the run
  if (subagentPromiseResolve) {
    (subagentPromiseResolve as () => void)();
  }
  await invokePromise;

  // The event sink should have been kept active until the end of the run
  expect(eventCount > 0).toBe(true);
});

it.sequential('codex resolves default_reasoning_level if agent.reasoningEffort is default', async () => {
  const settings = createMockSettings({
    'agent.provider': 'codex',
    'agent.model': 'gpt-5.3-codex',
    'agent.reasoningEffort': 'default',
  });

  registerProvider(
    {
      id: 'codex',
      label: 'Mock Codex',
      createRunner: () =>
        ({
          run: async (agent: any, _input: any, options: any) => {
            codexRunnerCalls.push({ agent, options });
            return {
              status: 'completed',
              finalOutput: 'ok',
              messages: [],
            };
          },
        } as any),
      fetchModels: async () => [{ id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', default_reasoning_level: 'medium' }],
      capabilities: {
        supportsConversationChaining: true,
        supportsTracingControl: true,
      },
    },
    { allowOverride: true },
  );

  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  await client.startStream('Hello');

  expect(codexRunnerCalls.length).toBe(1);
  const agent = codexRunnerCalls[0].agent;
  expect(agent).toBeTruthy();
  expect(agent.modelSettings?.reasoning?.effort).toBe('medium');
  expect(agent.defaultRunOptions?.reasoning?.effort).toBe('medium');
});

it.sequential('codex chat resolves default_reasoning_level if agent.reasoningEffort is default', async () => {
  const settings = createMockSettings({
    'agent.provider': 'codex',
    'agent.model': 'gpt-5.3-codex',
    'agent.reasoningEffort': 'default',
  });

  registerProvider(
    {
      id: 'codex',
      label: 'Mock Codex',
      createRunner: () =>
        ({
          run: async (agent: any, _input: any, options: any) => {
            codexRunnerCalls.push({ agent, options });
            return {
              status: 'completed',
              finalOutput: 'ok',
              messages: [],
            };
          },
        } as any),
      fetchModels: async () => [{ id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', default_reasoning_level: 'medium' }],
      capabilities: {
        supportsConversationChaining: true,
        supportsTracingControl: true,
      },
    },
    { allowOverride: true },
  );

  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  await client.chat('Hello', { provider: 'codex', model: 'gpt-5.3-codex', reasoningEffort: 'default' });

  expect(codexRunnerCalls.length).toBe(1);
  const agent = codexRunnerCalls[0].agent;
  expect(agent).toBeTruthy();
  expect(agent.modelSettings?.reasoning?.effort).toBe('medium');
});

it.sequential('AgentClient.abort aborts the injected SubagentBridge', () => {
  const settings = createMockSettings();
  const mockBridge = new SubagentBridge({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
    chat: async () => '',
    createClient: () => ({} as any),
  });
  const abortSpy = vi.spyOn(mockBridge, 'abort');

  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
    subagentBridge: mockBridge,
  });

  client.abort();

  expect(abortSpy).toHaveBeenCalledTimes(1);
});

it.sequential('AgentClient.startStream resets the SubagentBridge abort controller', async () => {
  const settings = createMockSettings();
  const mockBridge = new SubagentBridge({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
    chat: async () => '',
    createClient: () => ({} as any),
  });
  const resetSpy = vi.spyOn(mockBridge, 'resetAbortController');

  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
    subagentBridge: mockBridge,
  });

  await client.startStream('hello');

  expect(resetSpy).toHaveBeenCalledTimes(1);
});

it.sequential('main agent client injects warning into tool output when turns left <= 5', async () => {
  let executeOutput: string | null = null;

  registerProvider({
    id: 'mock-provider-maxturns',
    label: 'Mock Provider MaxTurns',
    createRunner: () =>
      ({
        run: async (agent: any, _input: any, options: any) => {
          if (options.callModelInputFilter) {
            // Simulate 96 turns
            for (let i = 0; i < 96; i++) {
              await options.callModelInputFilter({
                modelData: { input: [] },
                agent,
                context: options.context,
              });
            }
          }

          // Execute a tool to see if the warning is injected
          const readFileTool = agent.tools.find((tool: any) => tool.name === 'read_file');
          if (readFileTool) {
            const mockRunContext = {
              context: options.context,
            };
            executeOutput = await readFileTool.invoke(
              mockRunContext as any,
              JSON.stringify({ path: 'package.json' }),
              {},
            );
          }

          return {
            status: 'completed',
            finalOutput: 'done',
            history: [],
            messages: [],
          };
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const settings = createMockSettings({
    'agent.provider': 'mock-provider-maxturns',
    'agent.model': 'mock-model',
  });

  const client = new AgentClient({
    maxTurns: 100,
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  // Trigger startStream to initiate the provider run with correct context
  await client.startStream('Hello');

  expect(executeOutput).toBeTruthy();
  expect(executeOutput!.includes('approaching the maximum turn limit')).toBe(true);
  expect(executeOutput!.includes('4 turns left')).toBe(true);
});
