import { afterEach, expect, it, vi } from 'vitest';
import { getProvider, upsertProvider, unregisterProvider } from '../../src/model/providers/registry.js';
import '../../src/model/providers/index.js';
import { createOpenAICompatibleProviderDefinition } from '../../src/model/providers/openai-compatible.provider.js';
import type { ILoggingService, ISettingsService } from '../../src/shared/service-interfaces.js';
import { startFakeProviderHttpServer } from './fake-provider-http-server.js';
import { fixtureRequest } from './provider-wire-fixtures.js';

const providerId = 'token-limit-fixture';
afterEach(() => {
  unregisterProvider(providerId);
  vi.unstubAllGlobals();
});

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  security() {},
  setCorrelationId() {},
  getCorrelationId() {},
  clearCorrelationId() {},
} as ILoggingService;

// Crosses the real registry, provider SDK, fetch composition and loopback HTTP.
// A native-host request is redirected only at fetch, preserving the SDK's URL.
it.each([
  { name: 'native endpoint', native: true, options: {}, limit: 1234, expected: { max_completion_tokens: 1234 } },
  { name: 'compatible endpoint', native: false, options: {}, limit: 1234, expected: { max_tokens: 1234 } },
  {
    name: 'native explicit legacy override',
    native: true,
    options: { max_tokens: 44 },
    limit: 1234,
    expected: { max_tokens: 44 },
  },
  {
    name: 'compatible explicit modern override',
    native: false,
    options: { max_completion_tokens: 55 },
    limit: 1234,
    expected: { max_completion_tokens: 55 },
  },
  {
    name: 'native explicit modern override',
    native: true,
    options: { max_completion_tokens: 66 },
    limit: 1234,
    expected: { max_completion_tokens: 66 },
  },
  { name: 'no requested limit', native: true, options: {}, limit: undefined, expected: {} },
  {
    name: 'undefined native override retains the requested cap',
    native: true,
    options: { max_completion_tokens: undefined },
    limit: 1234,
    expected: { max_completion_tokens: 1234 },
  },
  {
    name: 'undefined compatible override retains the requested cap',
    native: false,
    options: { max_tokens: undefined },
    limit: 1234,
    expected: { max_tokens: 1234 },
  },
])('uses one caller-owned Chat token limit: $name', async ({ native, options, limit, expected }) => {
  const server = await startFakeProviderHttpServer({ protocol: 'chat-completions', scenario: 'success' });
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const destination = url.hostname === 'api.openai.com' ? server.baseUrl + url.pathname : url.href;
    return nativeFetch(destination, init);
  });
  const entry = {
    id: providerId,
    name: providerId,
    type: 'openai-compatible' as const,
    baseUrl: native ? 'https://api.openai.com/v1' : server.baseUrl + '/v1',
    apiKey: 'fixture',
  };
  const settings = {
    get: (key: string) => (key === 'agent.retryAttempts' ? 0 : undefined),
    getDynamic: (key: string) => (key === 'providers' ? [entry] : undefined),
  } as ISettingsService;
  upsertProvider(createOpenAICompatibleProviderDefinition({ ...entry, label: providerId }));
  try {
    const model = await getProvider(providerId)!.createStreamedModel!('future-reasoning-model', {
      settingsService: settings,
      loggingService: logger,
    });
    const events = [];
    for await (const event of model.stream({ ...fixtureRequest, maxTokens: limit, providerOptions: options }))
      events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'completion' });
    expect(server.requests).toHaveLength(1);
    const body = server.requests[0]!.body as Record<string, unknown>;
    const actual = Object.fromEntries(
      Object.entries(body).filter(([key]) => key === 'max_tokens' || key === 'max_completion_tokens'),
    );
    expect(actual).toEqual(expected);
    expect(body.reasoning_effort).toBe('medium');
    expect(body.tools).toBeDefined();
    expect(body.stream_options).toEqual({ include_usage: true });
  } finally {
    await server.close();
  }
});
