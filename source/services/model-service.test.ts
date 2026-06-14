import test from 'ava';
import { fetchModels, clearModelCache, filterModels } from './model-service.js';
import { createMockSettingsService } from './settings/settings-service.mock.js';

const originalApiKey = process.env.OPENAI_API_KEY;

test.beforeEach(() => {
  clearModelCache();
});

test.afterEach(() => {
  clearModelCache();
  process.env.OPENAI_API_KEY = originalApiKey;
});

test.serial('fetchModels uses OpenRouter endpoint and caches results', async (t) => {
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

  t.deepEqual(
    first.map((m) => m.id),
    ['openrouter/model-a', 'openrouter/model-c'],
  );
  t.is(second.length, first.length, 'Cache should be reused');
  // Only the first call should hit fetch because of caching
  if (calls.length !== 1) {
    console.log(
      'Calls:',
      calls.map((c) => ({ url: c.url, callNumber: c.callNumber })),
    );
  }
  t.is(calls.length, 1);
  t.true(calls[0].url.includes('/models'));
});

test.serial('fetchModels uses OpenAI models endpoint when provider is openai', async (t) => {
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

  t.deepEqual(
    models.map((m) => m.id),
    ['gpt-4.1', 'gpt-4o'],
  );
  t.is(calls.length, 1);
  t.is(calls[0].url, 'https://api.openai.com/v1/models');
  // Should include Authorization header when API key present
  t.truthy(calls[0].options?.headers?.Authorization);
});

test.serial('fetchModels uses /v1/models for custom OpenAI-compatible provider', async (t) => {
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

  t.deepEqual(
    models.map((m) => m.id),
    ['local-model-a', 'local-model-b'],
  );
  t.is(calls.length, 1);
  t.is(calls[0].url, 'http://localhost:1234/v1/models');
  t.is(calls[0].options?.headers?.Authorization, 'Bearer local-key');
});

test.serial('fetchModels uses Anthropic auth headers for custom anthropic provider', async (t) => {
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

  t.deepEqual(
    models.map((m) => m.id),
    ['claude-test-1', 'claude-test-2'],
  );
  t.is(calls.length, 1);
  t.is(calls[0].url, 'https://api.anthropic.com/v1/models');
  t.is(calls[0].options?.headers?.['x-api-key'], 'anthropic-key');
  t.is(calls[0].options?.headers?.['anthropic-version'], '2023-06-01');
});

test.serial('fetchModels uses Google auth headers for custom google provider', async (t) => {
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

  t.deepEqual(
    models.map((m) => m.id),
    ['gemini-test-1', 'gemini-test-2'],
  );
  t.is(calls.length, 1);
  t.is(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models');
  t.is(calls[0].options?.headers?.['x-goog-api-key'], 'google-key');
});

test('filterModels matches by id or name and limits results', (t) => {
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
  t.deepEqual(
    top.map((m) => m.id),
    ['meta/llama-3'],
  );

  const fuzzy = filterModels(models, 'gpt');
  t.is(fuzzy.length, 2);
});

test.serial('fetchModels logs and throws the error with cause details if present', async (t) => {
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

  const err = await t.throwsAsync(
    fetchModels(
      {
        settingsService,
        loggingService,
      },
      'openai',
      fakeFetch as any,
    ),
  );

  t.is(err, errorWithCause);
  t.is(err?.message, 'fetch failed (cause: connect ECONNREFUSED 127.0.0.1:443)');
  t.is(warnCalls.length, 1);
  t.is(warnCalls[0].msg, 'Failed to fetch models');
  t.is(warnCalls[0].meta.error, 'fetch failed (cause: connect ECONNREFUSED 127.0.0.1:443)');
});

test.serial('fetchModels logs and throws the standard error message when there is no cause', async (t) => {
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

  const err = await t.throwsAsync(
    fetchModels(
      {
        settingsService,
        loggingService,
      },
      'openai',
      fakeFetch as any,
    ),
  );

  t.is(err, errorWithoutCause);
  t.is(err?.message, 'Some standard error');
  t.is(warnCalls.length, 1);
  t.is(warnCalls[0].msg, 'Failed to fetch models');
  t.is(warnCalls[0].meta.error, 'Some standard error');
});
