import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getAllProviders,
  getProvider,
  unregisterProvider,
  upsertProvider,
  type ProviderDefinition,
} from '../../source/providers/registry.js';
import '../../source/providers/index.js';
import { createOpenAICompatibleProviderDefinition } from '../../source/providers/openai-compatible.provider.js';
import type { ILoggingService, ISettingsService } from '../../source/services/service-interfaces.js';
import { startFakeProviderHttpServer, type FakeProviderHttpServer } from './fake-provider-http-server.js';
import { fixtureRequest, fixtureTool, multiTurnFixture } from './provider-wire-fixtures.js';

type Protocol = 'chat-completions' | 'responses' | 'anthropic' | 'google';
type RuntimeProviderType = 'openai-compatible' | 'anthropic' | 'google';

interface ProviderCase {
  name: string;
  registryId: string;
  model: string;
  protocol: Protocol;
  expectedRoles: readonly string[];
  runtimeType?: RuntimeProviderType;
  providerOptions: Record<string, unknown>;
}

const providerCases: readonly ProviderCase[] = [
  {
    name: 'OpenAI Responses HTTP',
    registryId: 'openai',
    model: 'gpt-fixture',
    protocol: 'responses',
    expectedRoles: ['user', 'assistant', 'user'],
    providerOptions: { extraBody: { prompt_cache_key: 'fixture-cache' } },
  },
  {
    name: 'Chat Completions',
    registryId: 'fixture-chat-completions',
    model: 'chat-fixture',
    protocol: 'chat-completions',
    expectedRoles: ['user', 'assistant', 'user'],
    runtimeType: 'openai-compatible',
    providerOptions: { response_format: { type: 'text' } },
  },
  {
    name: 'Anthropic',
    registryId: 'fixture-anthropic',
    model: 'claude-fixture',
    protocol: 'anthropic',
    expectedRoles: ['user', 'assistant', 'user'],
    runtimeType: 'anthropic',
    providerOptions: { anthropic: { topK: 7 } },
  },
  {
    name: 'Google',
    registryId: 'fixture-google',
    model: 'gemini-fixture',
    protocol: 'google',
    expectedRoles: ['user', 'model', 'user'],
    runtimeType: 'google',
    providerOptions: {
      google: { safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }] },
    },
  },
  {
    name: 'OpenRouter',
    registryId: 'openrouter',
    model: 'fixture/provider',
    protocol: 'chat-completions',
    expectedRoles: ['user', 'assistant', 'user'],
    providerOptions: { transforms: ['middle-out'], reasoning: { effort: 'medium' } },
  },
] as const;

let server: FakeProviderHttpServer | undefined;
const runtimeProviderIds = new Set<string>();

afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const id of runtimeProviderIds) unregisterProvider(id);
  runtimeProviderIds.clear();
  vi.unstubAllGlobals();
});

describe('provider boundary contracts through the registry', () => {
  it('keeps the built-in registry surface available', () => {
    for (const id of ['openai', 'openrouter']) {
      expect(getProvider(id)?.createStreamedModel, id).toBeTypeOf('function');
    }
    expect(getAllProviders().length).toBeGreaterThanOrEqual(3);
  });

  it.each(providerCases)('$name succeeds with one authoritative completion', async (providerCase) => {
    const result = await runProviderCase(providerCase, 'success');
    const completions = result.events.filter((event) => event.type === 'completion');

    expect(completions).toHaveLength(1);
    expect(result.events.at(-1)).toBe(completions[0]);
    expect(completions[0]).toMatchObject({ type: 'completion', output: [{ type: 'message' }] });
    expect(completions[0]?.output?.[0]?.content?.[0]?.text).toBe('hello');
    expect(result.events.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'hello' },
    ]);
  });

  it.each(providerCases)(
    '$name preserves request roles, tools, reasoning, and provider options',
    async (providerCase) => {
      const result = await runProviderCase(providerCase, 'success');
      assertRequestShape(providerCase, result.body);
    },
  );

  it.each(providerCases)(
    '$name propagates a provider error instead of fabricating completion',
    async (providerCase) => {
      const result = await runProviderCaseExpectingError(providerCase);

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).not.toContain('hello');
      expect(result.events).toEqual([]);
    },
  );

  it('reassembles Chat Completions tool fragments with the authoritative tool ID', async () => {
    const providerCase = providerCases[1]!;
    const result = await runProviderCase(providerCase, 'tool-fragments');
    const toolEvents = result.events.filter((event) => event.type === 'tool_call');
    const completion = result.events.find((event) => event.type === 'completion');

    expect(toolEvents).toEqual([{ type: 'tool_call', id: 'call_fake', name: 'fixture', arguments: '{"a":1}' }]);
    expect(completion).toMatchObject({
      output: [{ type: 'tool_call', id: 'call_fake', name: 'fixture', arguments: '{"a":1}' }],
    });
  });
});

async function runProviderCase(providerCase: ProviderCase, scenario: 'success' | 'tool-fragments') {
  server = await startFakeProviderHttpServer({ scenario, protocol: providerCase.protocol });
  const settings = createSettings(providerCase);
  installOpenAiHttpRedirect(providerCase);
  registerRuntimeProvider(providerCase, settings);

  const provider = getProvider(providerCase.registryId);
  expect(provider?.createStreamedModel, providerCase.registryId).toBeTypeOf('function');
  const model = await provider!.createStreamedModel!(providerCase.model, {
    settingsService: settings,
    loggingService: quietLogging,
  });
  const events = await collect(model.stream(requestFor(providerCase)));

  expect(server.requests).toHaveLength(1);
  return { body: server.requests[0]!.body as Record<string, any>, events };
}

async function runProviderCaseExpectingError(providerCase: ProviderCase) {
  server = await startFakeProviderHttpServer({ scenario: 'error', protocol: providerCase.protocol });
  const settings = createSettings(providerCase);
  installOpenAiHttpRedirect(providerCase);
  registerRuntimeProvider(providerCase, settings);

  const provider = getProvider(providerCase.registryId);
  expect(provider?.createStreamedModel, providerCase.registryId).toBeTypeOf('function');
  const model = await provider!.createStreamedModel!(providerCase.model, {
    settingsService: settings,
    loggingService: quietLogging,
  });

  const events: unknown[] = [];
  let error: Error | undefined;
  try {
    for await (const event of model.stream(requestFor(providerCase))) events.push(event);
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }

  expect(server.requests).toHaveLength(1);
  return { error: error ?? new Error('provider stream unexpectedly completed'), events };
}

function requestFor(providerCase: ProviderCase) {
  return {
    ...fixtureRequest,
    input: multiTurnFixture,
    providerOptions: providerCase.providerOptions,
  };
}

function assertRequestShape(providerCase: ProviderCase, body: Record<string, any>) {
  if (providerCase.protocol !== 'google') expect(body.model).toBe(providerCase.model);
  expect(body.tools?.[0] ?? body.toolConfig?.functionCallingConfig).toBeDefined();

  if (providerCase.protocol === 'responses') {
    expect(body.input.filter((item: any) => item.type === 'message').map((item: any) => item.role)).toEqual(
      providerCase.expectedRoles,
    );
    expect(body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'message', role: 'user' }),
        expect.objectContaining({ type: 'message', role: 'assistant' }),
      ]),
    );
    expect(body.tools[0]).toMatchObject({ name: fixtureTool.name, parameters: fixtureTool.parameters });
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(body.prompt_cache_key).toBe('fixture-cache');
    expect(body.input.every((item: any) => item.type !== 'tool_call' && item.type !== 'tool_result')).toBe(true);
    return;
  }

  if (providerCase.protocol === 'chat-completions') {
    expect(body.messages.map((message: any) => message.role)).toEqual(providerCase.expectedRoles);
    expect(body.tools[0]).toMatchObject({ type: 'function', function: { name: fixtureTool.name } });
    if (providerCase.registryId === 'openrouter') {
      expect(body.transforms).toEqual(['middle-out']);
      expect(body.reasoning).toBeDefined();
    } else {
      expect(body.response_format).toEqual({ type: 'text' });
    }
    return;
  }

  if (providerCase.protocol === 'anthropic') {
    expect(body.messages.map((message: any) => message.role)).toEqual(providerCase.expectedRoles);
    expect(body.tools[0]).toMatchObject({ name: fixtureTool.name, input_schema: fixtureTool.parameters });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    return;
  }

  expect(body.contents.map((message: any) => message.role)).toEqual(providerCase.expectedRoles);
  expect(body.tools[0].functionDeclarations[0]).toMatchObject({ name: fixtureTool.name });
  expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 4096, includeThoughts: true });
  expect(body.safetySettings).toEqual([{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }]);
}

function registerRuntimeProvider(providerCase: ProviderCase, settings: ISettingsService) {
  if (!providerCase.runtimeType) return;
  const definition: ProviderDefinition = createOpenAICompatibleProviderDefinition({
    name: providerCase.registryId,
    label: providerCase.name,
    type: providerCase.runtimeType,
    baseUrl: server!.baseUrl,
    apiKey: 'fixture-key',
  });
  upsertProvider(definition);
  runtimeProviderIds.add(providerCase.registryId);
  expect(settings.getDynamic('providers')).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: providerCase.registryId })]),
  );
}

function createSettings(providerCase: ProviderCase): ISettingsService {
  const values: Record<string, unknown> = {
    'agent.model': providerCase.model,
    'agent.retryAttempts': 0,
    'agent.transport': 'http',
    'agent.openai.apiKey': 'fixture-key',
    'agent.openrouter.apiKey': 'fixture-key',
    'agent.openrouter.baseUrl': server?.baseUrl,
    'agent.openrouter.referrer': 'https://fixture.test',
    'agent.openrouter.title': 'provider-contract-test',
  };
  const providers = providerCase.runtimeType
    ? [
        {
          id: providerCase.registryId,
          name: providerCase.name,
          type: providerCase.runtimeType,
          baseUrl: server?.baseUrl,
          apiKey: 'fixture-key',
        },
      ]
    : [];
  return {
    get: (key: string) => values[key] as never,
    getDynamic: (key: string) => (key === 'providers' ? providers : undefined),
    set() {},
    setDynamic() {},
    setPersistent() {},
    setPersistentDynamic() {},
  } as ISettingsService;
}

const quietLogging: ILoggingService = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  security() {},
  setCorrelationId() {},
  getCorrelationId() {
    return undefined;
  },
  clearCorrelationId() {},
};

function installOpenAiHttpRedirect(providerCase: ProviderCase) {
  if (providerCase.registryId !== 'openai') return;
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const originalUrl = input instanceof URL ? input : new URL(String(input));
    const targetUrl = new URL(`${originalUrl.pathname}${originalUrl.search}`, server!.baseUrl);
    return nativeFetch(targetUrl, init);
  });
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
