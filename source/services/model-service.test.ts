import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { fetchModels, clearModelCache, filterModels } from './model-service.js';
import { createMockSettingsService } from './settings/settings-service.mock.js';

const originalApiKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  clearModelCache();
});

afterEach(() => {
  clearModelCache();
  process.env.OPENAI_API_KEY = originalApiKey;
});

it.sequential('fetchModels uses OpenRouter endpoint and caches results', async () => {
  const calls: Array<{ url: string; options: any; callNumber: number }> = [];
  let callCount = 0;
  const fakeFetch = async (url: string, options: any) => {
    callCount++;
    calls.push({ url, options, callNumber: callCount });
    return {
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'openrouter/model-a',
            name: 'Model A',
            supported_parameters: ['tools', 'temperature'],
          },
          {
            id: 'openrouter/model-b',
            name: 'Model B',
            supported_parameters: ['temperature'],
          },
          {
            id: 'openrouter/model-c',
            name: 'Model C',
            supported_parameters: ['tools', 'max_tokens'],
          },
        ],
      }),
    };
  };

  const first = await fetchModels(
    {
      settingsService: createMockSettingsService(),
      loggingService: { warn: () => {} } as any,
    },
    'openrouter',
    fakeFetch as any,
  );

  const second = await fetchModels(
    {
      settingsService: createMockSettingsService(),
      loggingService: { warn: () => {} } as any,
    },
    'openrouter',
    fakeFetch as any,
  );

  expect(first.map((m) => m.id)).toEqual(['openrouter/model-a', 'openrouter/model-c']);
  expect(second.length, 'Cache should be reused').toBe(first.length);
  // Only the first call should hit fetch because of caching
  if (calls.length !== 1) {
    console.log(
      'Calls:',
      calls.map((c) => ({ url: c.url, callNumber: c.callNumber })),
    );
  }
  expect(calls.length).toBe(1);
  expect(calls[0].url.includes('/models')).toBe(true);
});

it.sequential('fetchModels uses OpenAI models endpoint when provider is openai', async () => {
  process.env.OPENAI_API_KEY = 'key-openai-test';
  const calls: Array<{ url: string; options: any }> = [];

  const fakeFetch = async (url: string, options: any) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4.1' }] }),
    };
  };

  const models = await fetchModels(
    {
      settingsService: createMockSettingsService(),
      loggingService: { warn: () => {} } as any,
    },
    'openai',
    fakeFetch as any,
  );

  expect(models.map((m) => m.id)).toEqual(['gpt-4.1', 'gpt-4o']);
  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe('https://api.openai.com/v1/models');
  // Should include Authorization header when API key present
  expect(calls[0].options?.headers?.Authorization).toBeTruthy();
});

it.sequential('fetchModels uses /v1/models for custom OpenAI-compatible provider', async () => {
  const providerId = `lmstudio-test-${Date.now()}-${Math.random()}`;
  const settingsService = createMockSettingsService({
    providers: [
      {
        name: providerId,
        baseUrl: 'http://localhost:1234/v1',
        apiKey: 'local-key',
      },
    ],
  });

  const calls: Array<{ url: string; options: any }> = [];
  const fakeFetch = async (url: string, options: any) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        data: [{ id: 'local-model-a' }, { id: 'local-model-b' }],
      }),
    };
  };

  const models = await fetchModels(
    {
      settingsService,
      loggingService: { warn: () => {} } as any,
    },
    providerId,
    fakeFetch as any,
  );

  expect(models.map((m) => m.id)).toEqual(['local-model-a', 'local-model-b']);
  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe('http://localhost:1234/v1/models');
  expect(calls[0].options?.headers?.Authorization).toBe('Bearer local-key');
});

it.sequential('fetchModels uses Anthropic auth headers for custom anthropic provider', async () => {
  const providerId = `anthropic-test-${Date.now()}-${Math.random()}`;
  const settingsService = createMockSettingsService({
    providers: [
      {
        name: providerId,
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'anthropic-key',
      },
    ],
  });

  const calls: Array<{ url: string; options: any }> = [];
  const fakeFetch = async (url: string, options: any) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        data: [{ id: 'claude-test-1' }, { id: 'claude-test-2' }],
      }),
    };
  };

  const models = await fetchModels(
    {
      settingsService,
      loggingService: { warn: () => {} } as any,
    },
    providerId,
    fakeFetch as any,
  );

  expect(models.map((m) => m.id)).toEqual(['claude-test-1', 'claude-test-2']);
  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe('https://api.anthropic.com/v1/models');
  expect(calls[0].options?.headers?.['x-api-key']).toBe('anthropic-key');
  expect(calls[0].options?.headers?.['anthropic-version']).toBe('2023-06-01');
});

it.sequential('fetchModels uses Google auth headers for custom google provider', async () => {
  const providerId = `google-test-${Date.now()}-${Math.random()}`;
  const settingsService = createMockSettingsService({
    providers: [
      {
        name: providerId,
        type: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'google-key',
      },
    ],
  });

  const calls: Array<{ url: string; options: any }> = [];
  const fakeFetch = async (url: string, options: any) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-test-1', baseModelId: 'gemini-test-1', displayName: 'Gemini Test 1' },
          { name: 'models/gemini-test-2', baseModelId: 'gemini-test-2', displayName: 'Gemini Test 2' },
        ],
      }),
    };
  };

  const models = await fetchModels(
    {
      settingsService,
      loggingService: { warn: () => {} } as any,
    },
    providerId,
    fakeFetch as any,
  );

  expect(models.map((m) => m.id)).toEqual(['gemini-test-1', 'gemini-test-2']);
  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
  expect(calls[0].options?.headers?.['x-goog-api-key']).toBe('google-key');
});

it('filterModels matches by id or name and limits results', () => {
  const models = [
    { id: 'gpt-4o', name: 'OpenAI 4o', provider: 'openai' as const },
    { id: 'gpt-4.1', name: 'Reasoning', provider: 'openai' as const },
    { id: 'meta/llama-3', name: 'Llama 3', provider: 'openrouter' as const },
    {
      id: 'mistral-large',
      name: 'Mistral Large',
      provider: 'openrouter' as const,
    },
  ];

  const top = filterModels(models, 'llama');
  expect(top.map((m) => m.id)).toEqual(['meta/llama-3']);

  const fuzzy = filterModels(models, 'gpt');
  expect(fuzzy.length).toBe(2);
});

it.sequential('fetchModels logs and throws the error with cause details if present', async () => {
  const settingsService = createMockSettingsService();
  const warnCalls: any[] = [];
  const loggingService = {
    warn: (msg: string, meta?: any) => {
      warnCalls.push({ msg, meta });
    },
  } as any;

  const errorWithCause = new Error('fetch failed', {
    cause: new Error('connect ECONNREFUSED 127.0.0.1:443'),
  });
  const fakeFetch = async () => {
    throw errorWithCause;
  };

  await expect(
    fetchModels(
      {
        settingsService,
        loggingService,
      },
      'openai',
      fakeFetch as any,
    ),
  ).rejects.toThrow('fetch failed (cause: connect ECONNREFUSED 127.0.0.1:443)');
  expect(warnCalls.length).toBe(1);
  expect(warnCalls[0].msg).toBe('Failed to fetch models');
  expect(warnCalls[0].meta.error).toBe('fetch failed (cause: connect ECONNREFUSED 127.0.0.1:443)');
});

it.sequential('fetchModels logs and throws the standard error message when there is no cause', async () => {
  const settingsService = createMockSettingsService();
  const warnCalls: any[] = [];
  const loggingService = {
    warn: (msg: string, meta?: any) => {
      warnCalls.push({ msg, meta });
    },
  } as any;

  const errorWithoutCause = new Error('Some standard error');
  const fakeFetch = async () => {
    throw errorWithoutCause;
  };

  await expect(
    fetchModels(
      {
        settingsService,
        loggingService,
      },
      'openai',
      fakeFetch as any,
    ),
  ).rejects.toThrow('Some standard error');

  expect(warnCalls.length).toBe(1);
  expect(warnCalls[0].msg).toBe('Failed to fetch models');
  expect(warnCalls[0].meta.error).toBe('Some standard error');
});
