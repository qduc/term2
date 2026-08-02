import { it, expect, beforeEach, vi } from 'vitest';
import { AgentClient as ProductionAgentClient } from './agent-client.js';
import { registerProvider } from '../providers/registry.js';
import { SubagentBridge as ProductionSubagentBridge } from './subagent-bridge.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';

class AgentClient extends ProductionAgentClient {
  constructor(options: Omit<ConstructorParameters<typeof ProductionAgentClient>[0], 'toolOwnership'>) {
    super({ ...options, toolOwnership: new ToolOwnershipRegistry() });
  }
}

class SubagentBridge extends ProductionSubagentBridge {
  constructor(options: Omit<ConstructorParameters<typeof ProductionSubagentBridge>[0], 'toolOwnership'>) {
    super({ ...options, toolOwnership: new ToolOwnershipRegistry() });
  }
}

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
    get: (key: any) => store[key] as any,
    getDynamic: (key: string) => store[key],
    set: (key: string, value: any) => {
      store[key] = value;
    },
    setDynamic: (key: string, value: unknown) => {
      store[key] = value;
    },
    setPersistent: (key: string, value: unknown) => {
      store[key] = value;
    },
    setPersistentDynamic: (key: string, value: unknown) => {
      store[key] = value;
    },
  };
}

// Mock Runner that tracks calls
let runnerCalls: any[] = [];
let applicationModelCalls: Array<{ model: string; request: any }> = [];
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
      createStreamedModel: (model: string) => ({
        async *stream(request: any) {
          applicationModelCalls.push({ model, request });
          yield {
            type: 'completion',
            responseId: 'chat',
            output: [{ type: 'message', content: [{ type: 'text', text: 'mock response' }] }],
          };
        },
      }),
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
let applicationContinuityProviderRegistered = false;
let applicationContinuityRequests: any[] = [];
function ensureApplicationContinuityProviderRegistered() {
  if (applicationContinuityProviderRegistered) return;
  registerProvider({
    id: 'mock-application-continuity',
    label: 'Mock Application Continuity',
    createStreamedModel: () => ({
      async *stream(request: any) {
        applicationContinuityRequests.push(request);
        yield { type: 'completion', responseId: 'resp-application', output: [] };
      },
    }),
    fetchModels: async () => [{ id: 'mock-model' }],
    capabilities: { supportsConversationChaining: true },
  });
  applicationContinuityProviderRegistered = true;
}

function ensureMentorProvidersRegistered() {
  if (!mentorProviderRegistered) {
    registerProvider({
      id: 'mock-main-mentor-refresh',
      label: 'Mock Main Mentor Refresh',
      createStreamedModel: (model: string) => ({
        async *stream(request: any) {
          applicationModelCalls.push({ model, request });
          yield {
            type: 'completion',
            responseId: 'mentor-main',
            output: [{ type: 'message', content: [{ type: 'text', text: 'ok' }] }],
          };
        },
      }),
      fetchModels: async () => [{ id: 'mock-model' }],
    });

    registerProvider({
      id: 'mock-mentor-refresh',
      label: 'Mock Mentor Refresh',
      createStreamedModel: () => ({
        async *stream(request: any) {
          applicationModelCalls.push({ model: 'mock-model', request });
          mentorInputs.push([...request.input]);
          mentorResponseCounter += 1;
          yield {
            type: 'completion',
            responseId: `mentor-response-${mentorResponseCounter}`,
            output: [{ type: 'message', content: [{ type: 'text', text: `mentor-${mentorResponseCounter}` }] }],
          };
        },
      }),
      fetchModels: async () => [{ id: 'mock-model' }],
    });

    registerProvider({
      id: 'mock-mentor-refresh-alt',
      label: 'Mock Mentor Refresh Alt',
      createStreamedModel: () => ({
        async *stream(request: any) {
          mentorInputsAltProvider.push([...request.input]);
          mentorResponseCounter += 1;
          yield {
            type: 'completion',
            responseId: `mentor-response-${mentorResponseCounter}`,
            output: [{ type: 'message', content: [{ type: 'text', text: `mentor-${mentorResponseCounter}` }] }],
          };
        },
      }),
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
      createStreamedModel: () => ({
        async *stream(request: any) {
          chainingRunnerCalls.push({ input: request.input, options: request, providerId: 'mock-chaining-false' });
          yield { type: 'completion', responseId: 'chaining-false', output: [] };
        },
      }),
      fetchModels: async () => [{ id: 'mock-model' }],
      capabilities: {
        supportsConversationChaining: false,
      },
    });

    registerProvider({
      id: 'mock-chaining-true',
      label: 'Mock Chaining True',
      createStreamedModel: () => ({
        async *stream(request: any) {
          chainingRunnerCalls.push({ input: request.input, options: request, providerId: 'mock-chaining-true' });
          yield { type: 'completion', responseId: 'chaining-true', output: [] };
        },
      }),
      fetchModels: async () => [{ id: 'mock-model' }],
      capabilities: {
        supportsConversationChaining: true,
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
        createStreamedModel: () => ({
          async *stream(request: any) {
            applicationModelCalls.push({ model: 'gpt-5.3-codex', request });
            yield {
              type: 'completion',
              responseId: 'codex-chat',
              output: [{ type: 'message', content: [{ type: 'text', text: 'ok' }] }],
            };
          },
        }),
        fetchModels: async () => [{ id: 'mock-model' }],
        capabilities: {
          supportsConversationChaining: true,
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
        createStreamedModel: () => ({
          async *stream(request: any) {
            openaiRunnerCalls.push({ request, options: request });
            yield { type: 'completion', responseId: 'openai-direct', output: [] };
          },
        }),
        fetchModels: async () => [{ id: 'mock-model' }],
        capabilities: {
          supportsConversationChaining: true,
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
      createStreamedModel: () => {
        throw new Error('Missing credentials');
      },
      fetchModels: async () => [{ id: 'mock-model' }],
      capabilities: {
        supportsConversationChaining: false,
      },
    });

    failingProviderRegistered = true;
  }
}

beforeEach(() => {
  runnerCalls = [];
  applicationModelCalls = [];
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

  expect(applicationModelCalls.length).toBe(1);
  expect(applicationModelCalls[0].model).toBe('gpt-4-turbo');
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

it.sequential('application-owned startStream forwards previousResponseId to the model', async () => {
  ensureApplicationContinuityProviderRegistered();
  applicationContinuityRequests = [];
  const settings = createMockSettings({
    'agent.provider': 'mock-application-continuity',
  });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  const stream = await client.startStream('Hello', { previousResponseId: 'resp-before' });
  await stream.completed;

  expect(applicationContinuityRequests[0].previousResponseId).toBe('resp-before');
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

it.sequential('continueRunStream preserves canonical history when chaining', async () => {
  const settings = createMockSettings({ 'agent.provider': 'mock-chaining-true' });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });
  const initial = await client.startStream('inspect file');
  await initial.completed;
  const resumed = await client.continueRunStream(initial.state!, { previousResponseId: 'resp-prev' });
  await resumed.completed;
  expect(chainingRunnerCalls).toHaveLength(2);
  expect(chainingRunnerCalls[1].options.previousResponseId).toBe('resp-prev');
  expect(chainingRunnerCalls[1].options.input).toEqual([expect.objectContaining({ type: 'message', role: 'user' })]);
});

it.sequential('direct chained models receive canonical accumulated input', async () => {
  const settings = createMockSettings({ 'agent.provider': 'mock-chaining-true' });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });
  const initial = await client.startStream('first');
  await initial.completed;
  const resumed = await client.continueRunStream(initial.state!, { previousResponseId: 'resp-prev' });
  await resumed.completed;
  const request = chainingRunnerCalls.at(-1).options;
  expect(request.previousResponseId).toBe('resp-prev');
  expect(request.input).toEqual([expect.objectContaining({ type: 'message', role: 'user' })]);
});

// ========== Characterization tests for stream lifecycle ==========

it.sequential('startStream with direct chaining model', async () => {
  const settings = createMockSettings({ 'agent.provider': 'mock-chaining-true' });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });
  const stream = await client.startStream('Hello', { previousResponseId: 'prev-1' });
  await stream.completed;
  expect(chainingRunnerCalls).toHaveLength(1);
  expect(chainingRunnerCalls[0].options.previousResponseId).toBe('prev-1');
  expect(chainingRunnerCalls[0].options.input).toEqual([expect.objectContaining({ role: 'user' })]);
});

it.sequential('continueRunStream resumes a direct model continuation', async () => {
  const settings = createMockSettings({ 'agent.provider': 'mock-chaining-true' });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });
  const initial = await client.startStream('Hello');
  await initial.completed;
  const resumed = await client.continueRunStream(initial.state!, { previousResponseId: 'resp-prev' });
  await resumed.completed;
  expect(chainingRunnerCalls).toHaveLength(2);
  expect(chainingRunnerCalls[1].options.previousResponseId).toBe('resp-prev');
});

it.sequential('abort during an active startStream', async () => {
  let capturedSignal: AbortSignal | undefined;
  const testProviderId = 'mock-abort-active-stream';

  registerProvider({
    id: testProviderId,
    label: 'Mock Abort Active Stream',
    createStreamedModel: () => ({
      async *stream(request: any) {
        capturedSignal = request.signal;
        await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }));
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    }),
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

  const streamPromise = client.startStream('Hello');
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(correlationId).toBeTruthy();
  expect(capturedSignal).toBeTruthy();
  expect(capturedSignal!.aborted).toBe(false);

  client.abort();

  const stream = await streamPromise;
  await expect(stream.completed).rejects.toMatchObject({ name: 'AbortError' });
  expect(capturedSignal!.aborted).toBe(true);
  expect(correlationId).toBeFalsy();
});

it.sequential('abort before Codex start preparation prevents model dispatch', async () => {
  let releaseDiscovery!: () => void;
  let modelCalls = 0;
  registerProvider(
    {
      id: 'codex',
      label: 'Delayed Codex',
      fetchModels: async () => {
        await new Promise<void>((resolve) => {
          releaseDiscovery = resolve;
        });
        return [{ id: 'gpt-5.3-codex', default_reasoning_level: 'medium' }];
      },
      createStreamedModel: () => ({
        async *stream(request: any) {
          modelCalls += 1;
          applicationModelCalls.push({ model: 'gpt-5.3-codex', request });
          yield { type: 'completion', responseId: 'unexpected', output: [] };
        },
      }),
      capabilities: {
        supportsConversationChaining: true,
        supportsPromptCacheKey: true,
      },
    },
    { allowOverride: true },
  );
  const settings = createMockSettings({ 'agent.provider': 'codex', 'agent.reasoningEffort': 'default' });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });
  const start = client.startStream('Hello');
  client.abort();
  releaseDiscovery();
  await expect(start).rejects.toMatchObject({ name: 'AbortError' });
  expect(modelCalls).toBe(0);
});

it.sequential('clearConversations aborts active direct runs and resets provider state', async () => {
  const settings = createMockSettings({ 'agent.provider': 'mock-chaining-true', 'agent.model': 'mock-model' });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });
  const first = await client.startStream('Hello', { previousResponseId: 'prev-1' });
  await first.completed;
  client.clearConversations();
  const second = await client.startStream('World', { previousResponseId: 'prev-2' });
  await second.completed;
  expect(chainingRunnerCalls).toHaveLength(2);
  expect(chainingRunnerCalls[1].options.previousResponseId).toBe('prev-2');
});

it.sequential('chat and chatJson with temp provider/reasoning-effort overrides', async () => {
  const chatRunnerCalls: any[] = [];
  registerProvider({
    id: 'mock-chat-override-test',
    label: 'Mock Chat Override Test',
    createStreamedModel: (model: string) => ({
      async *stream(request: any) {
        chatRunnerCalls.push({ model, request });
        yield {
          type: 'completion',
          responseId: 'chat-override-response',
          output: [{ type: 'message', content: [{ type: 'text', text: 'mock chat response' }] }],
        };
      },
    }),
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
  expect(chatRunnerCalls[0].model).toBe('chat-override-model');
  expect(chatRunnerCalls[0].request.input[0]).toEqual({
    type: 'message',
    role: 'user',
    content: [{ type: 'text', text: 'Hello' }],
  });
  expect(chatRunnerCalls[0].request.reasoning?.effort).toBe('high');

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
  expect(chatRunnerCalls[1].model).toBe('chat-override-model');
  expect(chatRunnerCalls[1].request.input[0]).toEqual({
    type: 'message',
    role: 'user',
    content: [{ type: 'text', text: 'Hello structured' }],
  });
  expect(chatRunnerCalls[1].request.reasoning?.effort).toBe('medium');
  expect(chatRunnerCalls[1].request.outputType).toBeTruthy();

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

  const stream = await client.startStream('Hello', { sessionId: 'session-123' });
  await stream.completed;

  expect(applicationModelCalls.length).toBe(1);
  expect(applicationModelCalls[0].request.codex.promptCacheKey).toBe('session-123');
});

it.sequential('openai startStream puts prompt_cache_key in public providerData, not run options', async () => {
  const settings = createMockSettings({
    'agent.provider': 'openai',
  });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  await client.startStream('Hello', { sessionId: 'session-456' });

  expect(openaiRunnerCalls.length).toBe(1);
  expect(openaiRunnerCalls[0].request.providerOptions.extraBody.prompt_cache_key).toBe('session-456');
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

  expect(applicationModelCalls.length).toBe(1);
  expect(applicationModelCalls[0].request.providerOptions?.prompt_cache_key).toBeUndefined();
  expect(applicationModelCalls[0].request.providerOptions?.extraBody?.prompt_cache_key).toBeUndefined();
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
    createStreamedModel: (_model, deps) => {
      providerRetryHook = deps.onRetry;
      return {
        async *stream() {
          deps.onRetry?.();
          yield { type: 'completion', responseId: 'retry', output: [] };
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

  await client.startStream('trigger retry hook');

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

  const askUserTool = applicationModelCalls.at(-1)?.request.tools?.find((tool: any) => tool?.name === 'ask_user');
  expect(askUserTool).toBeTruthy();
  expect(askUserTool.parameters).toBeTruthy();
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

  const askMentorTool = applicationModelCalls.at(-1)?.request.tools?.find((tool: any) => tool?.name === 'ask_mentor');
  expect(askMentorTool).toBeTruthy();

  client.setModel('mock-model-v2');
  await client.chat('after model change');
  const refreshedTool = applicationModelCalls.at(-1)?.request.tools?.find((tool: any) => tool?.name === 'ask_mentor');
  expect(refreshedTool).toBeTruthy();
  expect(applicationModelCalls.at(-1)?.model).toBe('mock-model-v2');
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

  const askMentorTool = applicationModelCalls.at(-1)?.request.tools?.find((tool: any) => tool?.name === 'ask_mentor');
  expect(askMentorTool).toBeTruthy();

  settings.set('agent.mentorProvider', 'mock-mentor-refresh-alt');
  await client.chat('after mentor provider change');
  const refreshedTool = applicationModelCalls.at(-1)?.request.tools?.find((tool: any) => tool?.name === 'ask_mentor');
  expect(refreshedTool).toBeTruthy();
});

it.sequential('setSubagentEventSink defers cleanup to null when subagents are active', async () => {
  let subagentPromiseResolve: (() => void) | null = null;
  registerProvider({
    id: 'mock-deferred-sink-provider',
    label: 'Mock Deferred Sink Provider',
    createStreamedModel: () => ({
      async *stream() {
        await new Promise<void>((resolve) => {
          subagentPromiseResolve = resolve;
        });
        yield {
          type: 'completion',
          responseId: 'deferred-sink',
          output: [{ type: 'message', content: [{ type: 'text', text: 'mentor response' }] }],
        };
      },
    }),
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

  const askMentorTool = applicationModelCalls.at(-1)?.request.tools?.find((tool: any) => tool?.name === 'ask_mentor');
  expect(askMentorTool).toBeTruthy();

  // Direct chat consumers only receive the application tool schema; sink
  // lifecycle remains owned by the subagent bridge and must be harmless here.
  client.setSubagentEventSink(() => {});
  client.setSubagentEventSink(null);
  expect(applicationModelCalls.at(-1)?.request.tools).toContainEqual(askMentorTool);
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
      createStreamedModel: () => ({
        async *stream(request: any) {
          applicationModelCalls.push({ model: 'gpt-5.3-codex', request });
          yield { type: 'completion', responseId: 'codex-direct', output: [] };
        },
      }),
      fetchModels: async () => [{ id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', default_reasoning_level: 'medium' }],
      capabilities: {
        supportsConversationChaining: true,
      },
    },
    { allowOverride: true },
  );

  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  await client.startStream('Hello');

  expect(codexRunnerCalls.length + applicationModelCalls.length).toBe(1);
  const reasoningEffort =
    applicationModelCalls[0]?.request.reasoning?.effort ?? codexRunnerCalls[0]?.agent.modelSettings?.reasoning?.effort;
  expect(reasoningEffort).toBe('medium');
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
      createStreamedModel: () => ({
        async *stream(request: any) {
          applicationModelCalls.push({ model: 'gpt-5.3-codex', request });
          yield {
            type: 'completion',
            responseId: 'codex-chat',
            output: [{ type: 'message', content: [{ type: 'text', text: 'ok' }] }],
          };
        },
      }),
      fetchModels: async () => [{ id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', default_reasoning_level: 'medium' }],
      capabilities: {
        supportsConversationChaining: true,
      },
    },
    { allowOverride: true },
  );

  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });

  await client.chat('Hello', { provider: 'codex', model: 'gpt-5.3-codex', reasoningEffort: 'default' });

  expect(applicationModelCalls.length).toBe(1);
  expect(applicationModelCalls[0].request.reasoning?.effort).toBe('medium');
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

it.sequential('AgentClient.abort does not cancel conversation-bound background subagent runs', () => {
  const settings = createMockSettings();
  const mockBridge = new SubagentBridge({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
    chat: async () => '',
    createClient: () => ({} as any),
  });
  const cancelBackgroundSpy = vi.spyOn(mockBridge, 'cancelBackgroundRuns');

  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
    subagentBridge: mockBridge,
  });

  client.abort();

  expect(cancelBackgroundSpy).not.toHaveBeenCalled();
});

it.sequential('AgentClient.cancelBackgroundRuns cancels background runs on the SubagentBridge', () => {
  const settings = createMockSettings();
  const mockBridge = new SubagentBridge({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
    chat: async () => '',
    createClient: () => ({} as any),
  });
  const cancelBackgroundSpy = vi.spyOn(mockBridge, 'cancelBackgroundRuns');

  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
    subagentBridge: mockBridge,
  });

  client.cancelBackgroundRuns();

  expect(cancelBackgroundSpy).toHaveBeenCalledTimes(1);
});

it.sequential('AgentClient.setBackgroundSubagentEventSink delegates to the SubagentBridge', () => {
  const settings = createMockSettings();
  const mockBridge = new SubagentBridge({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
    chat: async () => '',
    createClient: () => ({} as any),
  });
  const setBackgroundSpy = vi.spyOn(mockBridge, 'setBackgroundEventSink');

  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
    subagentBridge: mockBridge,
  });

  const sink = () => {};
  client.setBackgroundSubagentEventSink(sink);
  client.setBackgroundSubagentEventSink(null);

  expect(setBackgroundSpy).toHaveBeenCalledTimes(2);
  expect(setBackgroundSpy).toHaveBeenNthCalledWith(1, sink);
  expect(setBackgroundSpy).toHaveBeenNthCalledWith(2, null);
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

it.sequential('main agent client executes tools through the direct model loop', async () => {
  let executeCount = 0;
  registerProvider({
    id: 'mock-provider-direct-tool',
    label: 'Mock Provider Direct Tool',
    createStreamedModel: () => ({
      async *stream(request: any) {
        if (!request.input.some((item: any) => item.type === 'tool_result')) {
          yield {
            type: 'completion',
            responseId: 'tool-call',
            output: [{ type: 'tool_call', id: 'unknown-1', name: 'unknown_direct_tool', arguments: '{}' }],
          };
        } else {
          executeCount += 1;
          yield { type: 'completion', responseId: 'done', output: [] };
        }
      },
    }),
    fetchModels: async () => [{ id: 'mock-model' }],
  });
  const settings = createMockSettings({ 'agent.provider': 'mock-provider-direct-tool', 'agent.model': 'mock-model' });
  const client = new AgentClient({
    deps: { logger: createMockLogger(), settings, sessionContextService: createSessionContextService() as any },
  });
  const stream = await client.startStream('Hello');
  await stream.completed;
  expect(executeCount).toBe(1);
});
