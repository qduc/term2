import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it, expect, beforeEach, afterEach, describe, beforeAll, afterAll } from 'vitest';
import {
  fetchModels,
  clearModelCache,
  filterModels,
  MODEL_CACHE_TTL_MS,
  getModelCacheDir,
  getModelCacheFilePath,
  clearModelMemoryCacheForTest,
  setModelCacheDirForTest,
  setModelCacheClockForTest,
  isStrictSubsetModels,
} from './model-service.js';
import { createMockSettingsService } from './settings/settings-service.mock.js';
import { registerProvider, unregisterProvider } from '../providers/index.js';
import { ModelCatalogSession } from './models/model-catalog-session.js';

const originalApiKey = process.env.OPENAI_API_KEY;
let fileLevelCacheDir: string;
let originalEnvCacheDir: string | undefined;

beforeAll(() => {
  fileLevelCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-model-service-top-'));
  originalEnvCacheDir = process.env.TERM2_CACHE_DIR;
  process.env.TERM2_CACHE_DIR = fileLevelCacheDir;
  setModelCacheDirForTest?.(fileLevelCacheDir);
});

afterAll(() => {
  if (originalEnvCacheDir !== undefined) {
    process.env.TERM2_CACHE_DIR = originalEnvCacheDir;
  } else {
    delete process.env.TERM2_CACHE_DIR;
  }
  setModelCacheDirForTest?.(null);
  try {
    fs.rmSync(fileLevelCacheDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

beforeEach(() => {
  clearModelCache();
});

afterEach(() => {
  clearModelCache();
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
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

it.sequential('fetchModels attaches contextWindow from the vendored catalog', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-4o' }, { id: 'unknown-model-xyz' }] }),
  });

  const models = await fetchModels(
    {
      settingsService: createMockSettingsService(),
      loggingService: { warn: () => {} } as any,
    },
    'openai',
    fakeFetch as any,
  );

  const byId = new Map(models.map((m) => [m.id, m]));
  expect(byId.get('gpt-5.6-sol')?.contextWindow).toBe(272000);
  expect(byId.get('gpt-4o')?.contextWindow).toBe(128000);
  // Models the catalog does not know keep contextWindow undefined.
  expect(byId.get('unknown-model-xyz')?.contextWindow).toBeUndefined();
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
  expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models?key=google-key');
  expect(calls[0].options?.headers?.['x-goog-api-key']).toBeUndefined();
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

it.sequential('a providers config change evicts only the changed provider cache entry', async () => {
  const settingsService = createMockSettingsService();
  const changedId = `cache-changed-${Date.now()}-${Math.random()}`;
  const keptId = `cache-kept-${Date.now()}-${Math.random()}`;
  const changedConfig = {
    id: changedId,
    name: changedId,
    type: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:43121/v1',
  };
  const keptConfig = {
    id: keptId,
    name: keptId,
    type: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:43122/v1',
  };
  let changedFetches = 0;
  let keptFetches = 0;

  registerProvider({
    id: changedId,
    label: changedId,
    fetchModels: async () => {
      changedFetches++;
      return [{ id: 'changed-model' }];
    },
  });
  registerProvider({
    id: keptId,
    label: keptId,
    fetchModels: async () => {
      keptFetches++;
      return [{ id: 'kept-model' }];
    },
  });

  try {
    settingsService.setPersistentDynamic('providers', [changedConfig, keptConfig]);

    await fetchModels({ settingsService, loggingService: { warn: () => {} } as any }, changedId);
    await fetchModels({ settingsService, loggingService: { warn: () => {} } as any }, keptId);
    expect(changedFetches).toBe(1);
    expect(keptFetches).toBe(1);

    // Same-id config update: only the changed provider's cached models are
    // evicted at the settings boundary; the untouched provider keeps its cache.
    settingsService.setPersistentDynamic('providers', [
      { ...changedConfig, baseUrl: 'http://127.0.0.1:43123/v1' },
      keptConfig,
    ]);

    await fetchModels({ settingsService, loggingService: { warn: () => {} } as any }, changedId);
    await fetchModels({ settingsService, loggingService: { warn: () => {} } as any }, keptId);
    expect(changedFetches).toBe(2);
    expect(keptFetches).toBe(1);
  } finally {
    unregisterProvider(changedId);
    unregisterProvider(keptId);
    clearModelCache();
  }
});

describe.sequential('model disk cache', () => {
  let testDir: string;
  let prevEnvCacheDir: string | undefined;

  beforeAll(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-model-disk-cache-suite-'));
    prevEnvCacheDir = process.env.TERM2_CACHE_DIR;
    process.env.TERM2_CACHE_DIR = testDir;
    setModelCacheDirForTest(testDir);
  });

  afterAll(() => {
    if (prevEnvCacheDir !== undefined) {
      process.env.TERM2_CACHE_DIR = prevEnvCacheDir;
    } else {
      delete process.env.TERM2_CACHE_DIR;
    }
    setModelCacheDirForTest(fileLevelCacheDir);
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(() => {
    clearModelCache();
    setModelCacheClockForTest(null);
  });

  afterEach(() => {
    clearModelCache();
    setModelCacheClockForTest(null);
  });

  it('writes models to disk cache on initial fetch with version, timestamp, and models', async () => {
    const providerId = 'openrouter';
    let fetchCount = 0;
    const fakeFetch = async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => ({
          data: [{ id: 'openrouter/test-model', supported_parameters: ['tools'] }],
        }),
      };
    };

    const models = await fetchModels(
      {
        settingsService: createMockSettingsService(),
        loggingService: { warn: () => {} } as any,
      },
      providerId,
      fakeFetch as any,
    );

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('openrouter/test-model');
    expect(fetchCount).toBe(1);

    const cacheFilePath = getModelCacheFilePath(providerId);
    expect(fs.existsSync(cacheFilePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));
    expect(content.version).toBe(1);
    expect(content.provider).toBe(providerId);
    expect(typeof content.timestamp).toBe('number');
    expect(Array.isArray(content.models)).toBe(true);
    expect(content.models[0].id).toBe('openrouter/test-model');
  });

  it('serves models from disk cache when in-memory cache is empty without re-fetching', async () => {
    const providerId = 'disk-hit-provider';
    let fetchCount = 0;
    registerProvider({
      id: providerId,
      label: providerId,
      fetchModels: async () => {
        fetchCount++;
        return [{ id: 'disk-hit-model' }];
      },
    });

    try {
      // 1. First fetch populates disk and in-memory cache
      const first = await fetchModels(
        {
          settingsService: createMockSettingsService(),
          loggingService: { warn: () => {} } as any,
        },
        providerId,
      );
      expect(first).toEqual([{ id: 'disk-hit-model', provider: providerId }]);
      expect(fetchCount).toBe(1);

      // 2. Clear ONLY in-memory cache to simulate a fresh process invocation
      clearModelMemoryCacheForTest();

      // 3. Second fetch should hit disk cache without invoking provider fetchModels
      const second = await fetchModels(
        {
          settingsService: createMockSettingsService(),
          loggingService: { warn: () => {} } as any,
        },
        providerId,
      );
      expect(second).toEqual([{ id: 'disk-hit-model', provider: providerId }]);
      expect(fetchCount, 'Provider fetch should not be called on disk cache hit').toBe(1);
    } finally {
      unregisterProvider(providerId);
    }
  });

  it('in-memory cache takes precedence over disk when warm without re-reading disk', async () => {
    const providerId = 'in-memory-precedence';
    let fetchCount = 0;
    registerProvider({
      id: providerId,
      label: providerId,
      fetchModels: async () => {
        fetchCount++;
        return [{ id: 'initial-model' }];
      },
    });

    try {
      await fetchModels(
        {
          settingsService: createMockSettingsService(),
          loggingService: { warn: () => {} } as any,
        },
        providerId,
      );
      expect(fetchCount).toBe(1);

      // Mutate or delete disk cache file
      const cacheFilePath = getModelCacheFilePath(providerId);
      fs.writeFileSync(
        cacheFilePath,
        JSON.stringify({ version: 1, provider: providerId, timestamp: Date.now(), models: [{ id: 'disk-altered' }] }),
      );

      // Fetch again while in-memory cache is warm
      const result = await fetchModels(
        {
          settingsService: createMockSettingsService(),
          loggingService: { warn: () => {} } as any,
        },
        providerId,
      );

      // Should return the in-memory models, not the altered disk models
      expect(result[0].id).toBe('initial-model');
      expect(fetchCount).toBe(1);
    } finally {
      unregisterProvider(providerId);
    }
  });

  it('serves models from disk within TTL (e.g. 59 minutes elapsed)', async () => {
    const providerId = 'ttl-hit-provider';
    let fetchCount = 0;
    registerProvider({
      id: providerId,
      label: providerId,
      fetchModels: async () => {
        fetchCount++;
        return [{ id: 'ttl-model' }];
      },
    });

    try {
      let now = 10_000_000;
      const clock = () => now;

      await fetchModels(
        {
          settingsService: createMockSettingsService(),
          loggingService: { warn: () => {} } as any,
          now: clock,
        },
        providerId,
      );
      expect(fetchCount).toBe(1);

      // Clear memory cache, advance time by 59 minutes (3540 seconds)
      clearModelMemoryCacheForTest();
      now += 59 * 60 * 1000;

      const cached = await fetchModels(
        {
          settingsService: createMockSettingsService(),
          loggingService: { warn: () => {} } as any,
          now: clock,
        },
        providerId,
      );
      expect(cached[0].id).toBe('ttl-model');
      expect(fetchCount).toBe(1);
    } finally {
      unregisterProvider(providerId);
    }
  });

  it('treats disk cache older than 1 hour as expired (miss), re-fetches and overwrites', async () => {
    const providerId = 'ttl-expire-provider';
    let fetchCount = 0;
    registerProvider({
      id: providerId,
      label: providerId,
      fetchModels: async () => {
        fetchCount++;
        return [{ id: `ttl-model-${fetchCount}` }];
      },
    });

    try {
      let now = 20_000_000;
      const clock = () => now;

      const first = await fetchModels(
        {
          settingsService: createMockSettingsService(),
          loggingService: { warn: () => {} } as any,
          now: clock,
        },
        providerId,
      );
      expect(first[0].id).toBe('ttl-model-1');
      expect(fetchCount).toBe(1);

      // Clear memory cache, advance time by 60 minutes + 1 second (> 1 hour)
      clearModelMemoryCacheForTest();
      now += MODEL_CACHE_TTL_MS + 1000;

      const second = await fetchModels(
        {
          settingsService: createMockSettingsService(),
          loggingService: { warn: () => {} } as any,
          now: clock,
        },
        providerId,
      );
      expect(second[0].id).toBe('ttl-model-2');
      expect(fetchCount).toBe(2);

      // Verify disk cache file timestamp was updated to the new now
      const cacheFilePath = getModelCacheFilePath(providerId);
      const content = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));
      expect(content.timestamp).toBe(now);
      expect(content.models[0].id).toBe('ttl-model-2');
    } finally {
      unregisterProvider(providerId);
    }
  });

  it('tolerates corrupted JSON in disk cache file by treating as miss and overwriting', async () => {
    const providerId = 'corrupt-json-provider';
    let fetchCount = 0;
    registerProvider({
      id: providerId,
      label: providerId,
      fetchModels: async () => {
        fetchCount++;
        return [{ id: 'fresh-model' }];
      },
    });

    try {
      const cacheFilePath = getModelCacheFilePath(providerId);
      fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
      fs.writeFileSync(cacheFilePath, '{{{not valid json!!!');

      clearModelMemoryCacheForTest();

      const models = await fetchModels(
        {
          settingsService: createMockSettingsService(),
          loggingService: { warn: () => {}, debug: () => {} } as any,
        },
        providerId,
      );

      expect(models[0].id).toBe('fresh-model');
      expect(fetchCount).toBe(1);

      // File should have been overwritten with valid cache data
      const parsed = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));
      expect(parsed.version).toBe(1);
      expect(parsed.models[0].id).toBe('fresh-model');
    } finally {
      unregisterProvider(providerId);
    }
  });

  it('tolerates malformed schema in disk cache file (invalid version, missing models, non-array)', async () => {
    const providerId = 'malformed-schema-provider';
    let fetchCount = 0;
    registerProvider({
      id: providerId,
      label: providerId,
      fetchModels: async () => {
        fetchCount++;
        return [{ id: 'recovered-model' }];
      },
    });

    try {
      const cacheFilePath = getModelCacheFilePath(providerId);
      fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });

      // Case 1: Wrong version
      fs.writeFileSync(cacheFilePath, JSON.stringify({ version: 99, timestamp: Date.now(), models: [{ id: 'bad' }] }));
      clearModelMemoryCacheForTest();
      let models = await fetchModels(
        { settingsService: createMockSettingsService(), loggingService: { warn: () => {} } as any },
        providerId,
      );
      expect(models[0].id).toBe('recovered-model');
      expect(fetchCount).toBe(1);

      // Case 2: Models is not an array
      fs.writeFileSync(cacheFilePath, JSON.stringify({ version: 1, timestamp: Date.now(), models: 'not an array' }));
      clearModelMemoryCacheForTest();
      models = await fetchModels(
        { settingsService: createMockSettingsService(), loggingService: { warn: () => {} } as any },
        providerId,
      );
      expect(fetchCount).toBe(2);

      // Case 3: Timestamp is invalid
      fs.writeFileSync(cacheFilePath, JSON.stringify({ version: 1, timestamp: 'never', models: [] }));
      clearModelMemoryCacheForTest();
      models = await fetchModels(
        { settingsService: createMockSettingsService(), loggingService: { warn: () => {} } as any },
        providerId,
      );
      expect(fetchCount).toBe(3);
    } finally {
      unregisterProvider(providerId);
    }
  });

  it('tolerates invalid model elements in disk cache file by treating as miss', async () => {
    const providerId = 'invalid-model-elements-provider';
    let fetchCount = 0;
    registerProvider({
      id: providerId,
      label: providerId,
      fetchModels: async () => {
        fetchCount++;
        return [{ id: 'valid-recovered' }];
      },
    });

    try {
      const cacheFilePath = getModelCacheFilePath(providerId);
      fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
      fs.writeFileSync(
        cacheFilePath,
        JSON.stringify({ version: 1, timestamp: Date.now(), models: [null, { noId: 123 }] }),
      );
      clearModelMemoryCacheForTest();

      const models = await fetchModels(
        { settingsService: createMockSettingsService(), loggingService: { warn: () => {} } as any },
        providerId,
      );
      expect(models[0].id).toBe('valid-recovered');
      expect(fetchCount).toBe(1);
    } finally {
      unregisterProvider(providerId);
    }
  });

  it('clearModelCache(provider) removes only that provider disk cache file', async () => {
    const p1 = 'clear-p1';
    const p2 = 'clear-p2';
    registerProvider({ id: p1, label: p1, fetchModels: async () => [{ id: 'm1' }] });
    registerProvider({ id: p2, label: p2, fetchModels: async () => [{ id: 'm2' }] });

    try {
      await fetchModels(
        { settingsService: createMockSettingsService(), loggingService: { warn: () => {} } as any },
        p1,
      );
      await fetchModels(
        { settingsService: createMockSettingsService(), loggingService: { warn: () => {} } as any },
        p2,
      );

      const p1Path = getModelCacheFilePath(p1);
      const p2Path = getModelCacheFilePath(p2);
      expect(fs.existsSync(p1Path)).toBe(true);
      expect(fs.existsSync(p2Path)).toBe(true);

      // Clear only p1
      clearModelCache(p1);
      expect(fs.existsSync(p1Path), 'p1 disk cache should be deleted').toBe(false);
      expect(fs.existsSync(p2Path), 'p2 disk cache should remain intact').toBe(true);
    } finally {
      unregisterProvider(p1);
      unregisterProvider(p2);
    }
  });

  it('clearModelCache() removes all provider disk cache files', async () => {
    const p1 = 'all-p1';
    const p2 = 'all-p2';
    registerProvider({ id: p1, label: p1, fetchModels: async () => [{ id: 'm1' }] });
    registerProvider({ id: p2, label: p2, fetchModels: async () => [{ id: 'm2' }] });

    try {
      await fetchModels(
        { settingsService: createMockSettingsService(), loggingService: { warn: () => {} } as any },
        p1,
      );
      await fetchModels(
        { settingsService: createMockSettingsService(), loggingService: { warn: () => {} } as any },
        p2,
      );

      const p1Path = getModelCacheFilePath(p1);
      const p2Path = getModelCacheFilePath(p2);
      expect(fs.existsSync(p1Path)).toBe(true);
      expect(fs.existsSync(p2Path)).toBe(true);

      // Clear all
      clearModelCache();
      expect(fs.existsSync(p1Path)).toBe(false);
      expect(fs.existsSync(p2Path)).toBe(false);
    } finally {
      unregisterProvider(p1);
      unregisterProvider(p2);
    }
  });

  it('concurrent atomic writes to the same provider cache file do not corrupt the file', async () => {
    const providerId = 'concurrent-provider';
    registerProvider({
      id: providerId,
      label: providerId,
      fetchModels: async () => [{ id: 'conc-model' }],
    });

    try {
      // Fire 10 parallel fetches
      const promises = Array.from({ length: 10 }, (_, i) => {
        // Clear memory cache between each call to force disk writes
        clearModelMemoryCacheForTest();
        return fetchModels(
          {
            settingsService: createMockSettingsService(),
            loggingService: { warn: () => {} } as any,
          },
          providerId,
        );
      });

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res[0].id).toBe('conc-model');
      }

      // Assert that the final file is valid JSON and parses cleanly
      const cacheFilePath = getModelCacheFilePath(providerId);
      expect(fs.existsSync(cacheFilePath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));
      expect(parsed.version).toBe(1);
      expect(parsed.provider).toBe(providerId);
      expect(parsed.models[0].id).toBe('conc-model');
    } finally {
      unregisterProvider(providerId);
    }
  });

  it('ModelCatalogSession.invalidate removes disk cache file for that provider', async () => {
    const providerId = 'session-invalidate-provider';
    let fetchCount = 0;
    registerProvider({
      id: providerId,
      label: providerId,
      fetchModels: async () => {
        fetchCount++;
        return [{ id: 'sess-model' }];
      },
    });

    try {
      const session = new ModelCatalogSession({
        settingsService: createMockSettingsService(),
        loggingService: { warn: () => {} } as any,
      });

      await session.load(providerId);
      expect(fetchCount).toBe(1);

      const cacheFilePath = getModelCacheFilePath(providerId);
      expect(fs.existsSync(cacheFilePath)).toBe(true);

      // Invalidate provider in session
      session.invalidate(providerId);

      // Disk cache file must be removed
      expect(fs.existsSync(cacheFilePath)).toBe(false);

      // Loading again should hit the fetcher fresh
      await session.load(providerId);
      expect(fetchCount).toBe(2);
    } finally {
      unregisterProvider(providerId);
    }
  });

  it('respects custom cacheDir passed in deps', async () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-cache-dir-'));
    const providerId = 'custom-dir-provider';
    registerProvider({
      id: providerId,
      label: providerId,
      fetchModels: async () => [{ id: 'custom-dir-model' }],
    });

    try {
      await fetchModels(
        {
          settingsService: createMockSettingsService(),
          loggingService: { warn: () => {} } as any,
          cacheDir: customDir,
        },
        providerId,
      );

      const customCacheFile = getModelCacheFilePath(providerId, customDir);
      expect(fs.existsSync(customCacheFile)).toBe(true);

      // Default suite cache dir should NOT have this file
      expect(fs.existsSync(getModelCacheFilePath(providerId))).toBe(false);

      // clearModelCache with opts.cacheDir cleans up
      clearModelCache(providerId, { cacheDir: customDir });
      expect(fs.existsSync(customCacheFile)).toBe(false);
    } finally {
      unregisterProvider(providerId);
      try {
        fs.rmSync(customDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('sanitizes provider IDs injectively so distinct IDs with underscores and escaped characters do not collide', async () => {
    const p1 = 'gemini/flash';
    const p2 = 'gemini_2f_flash';

    const p1Path = getModelCacheFilePath(p1);
    const p2Path = getModelCacheFilePath(p2);

    // Filenames must be strictly distinct
    expect(p1Path).not.toBe(p2Path);
    expect(p1Path).toContain('gemini_2f_flash.json');
    expect(p2Path).toContain('gemini_5f_2f_5f_flash.json');

    // Verify end-to-end cache isolation between both providers
    registerProvider({ id: p1, label: p1, fetchModels: async () => [{ id: 'model-slash' }] });
    registerProvider({ id: p2, label: p2, fetchModels: async () => [{ id: 'model-escaped' }] });

    try {
      await fetchModels(
        { settingsService: createMockSettingsService(), loggingService: { warn: () => {} } as any },
        p1,
      );
      await fetchModels(
        { settingsService: createMockSettingsService(), loggingService: { warn: () => {} } as any },
        p2,
      );

      expect(fs.existsSync(p1Path)).toBe(true);
      expect(fs.existsSync(p2Path)).toBe(true);

      // Clear memory cache to force disk read
      clearModelMemoryCacheForTest();

      const p1Loaded = await fetchModels(
        { settingsService: createMockSettingsService(), loggingService: { warn: () => {} } as any },
        p1,
      );
      const p2Loaded = await fetchModels(
        { settingsService: createMockSettingsService(), loggingService: { warn: () => {} } as any },
        p2,
      );

      expect(p1Loaded[0].id).toBe('model-slash');
      expect(p2Loaded[0].id).toBe('model-escaped');
    } finally {
      unregisterProvider(p1);
      unregisterProvider(p2);
    }
  });

  it('preserves last-known-good cache when provider returns a strict subset (degraded list)', async () => {
    const providerId = 'degraded-subset-provider';
    let fetchCount = 0;
    const healthyList = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }];
    const degradedList = [{ id: 'm1' }];

    registerProvider({
      id: providerId,
      label: providerId,
      fetchModels: async () => {
        fetchCount++;
        return fetchCount === 1 ? healthyList : degradedList;
      },
    });

    try {
      let now = 50_000_000;
      const clock = () => now;

      // 1. Initial healthy fetch
      const first = await fetchModels(
        {
          settingsService: createMockSettingsService(),
          loggingService: { warn: () => {}, debug: () => {} } as any,
          now: clock,
        },
        providerId,
      );
      expect(first.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
      expect(fetchCount).toBe(1);

      // 2. Advance time past TTL (cache expires on disk)
      clearModelMemoryCacheForTest();
      now += MODEL_CACHE_TTL_MS + 1000;

      // 3. Second fetch receives degraded strict subset and retry also returns degraded
      const second = await fetchModels(
        {
          settingsService: createMockSettingsService(),
          loggingService: { warn: () => {}, debug: () => {} } as any,
          now: clock,
        },
        providerId,
      );

      // Should preserve the healthy list rather than poisoning with the degraded one
      expect(second.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
      // 1 initial + 1 degraded + 1 immediate retry = 3
      expect(fetchCount).toBe(3);

      // Verify disk cache was NOT overwritten with degraded list
      const cacheFilePath = getModelCacheFilePath(providerId);
      const diskContent = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));
      expect(diskContent.models.map((m: any) => m.id)).toEqual(['m1', 'm2', 'm3']);
    } finally {
      unregisterProvider(providerId);
    }
  });

  it('recovers on immediate retry when initial fetch returns a degraded strict subset', async () => {
    const providerId = 'recover-retry-provider';
    let fetchCount = 0;
    const healthyList = [{ id: 'm1' }, { id: 'm2' }];
    const degradedList = [{ id: 'm1' }];
    const recoveredList = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }];

    registerProvider({
      id: providerId,
      label: providerId,
      fetchModels: async () => {
        fetchCount++;
        if (fetchCount === 1) return healthyList;
        if (fetchCount === 2) return degradedList;
        return recoveredList;
      },
    });

    try {
      let now = 60_000_000;
      const clock = () => now;

      // Initial healthy fetch
      await fetchModels(
        {
          settingsService: createMockSettingsService(),
          loggingService: { warn: () => {}, debug: () => {} } as any,
          now: clock,
        },
        providerId,
      );

      // Cache expires on disk
      clearModelMemoryCacheForTest();
      now += MODEL_CACHE_TTL_MS + 1000;

      // Second fetch: call 2 returns degraded, call 3 (retry) returns recovered list
      const result = await fetchModels(
        {
          settingsService: createMockSettingsService(),
          loggingService: { warn: () => {}, debug: () => {}, info: () => {} } as any,
          now: clock,
        },
        providerId,
      );

      expect(result.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
      expect(fetchCount).toBe(3);

      // Disk cache should have the recovered list
      const cacheFilePath = getModelCacheFilePath(providerId);
      const diskContent = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));
      expect(diskContent.models.map((m: any) => m.id)).toEqual(['m1', 'm2', 'm3']);
    } finally {
      unregisterProvider(providerId);
    }
  });

  it('never treats empty catalog [] as a disk cache hit', async () => {
    const providerId = 'empty-cache-disk-provider';
    const cacheFilePath = getModelCacheFilePath(providerId);
    fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
    fs.writeFileSync(
      cacheFilePath,
      JSON.stringify({ version: 1, provider: providerId, timestamp: Date.now(), models: [] }),
    );

    let fetchCount = 0;
    registerProvider({
      id: providerId,
      label: providerId,
      fetchModels: async () => {
        fetchCount++;
        return [{ id: 'non-empty-model' }];
      },
    });

    try {
      clearModelMemoryCacheForTest();
      const models = await fetchModels(
        {
          settingsService: createMockSettingsService(),
          loggingService: { warn: () => {}, debug: () => {} } as any,
        },
        providerId,
      );

      expect(models.map((m) => m.id)).toEqual(['non-empty-model']);
      expect(fetchCount).toBe(1);
    } finally {
      unregisterProvider(providerId);
    }
  });

  it('evicts in-memory cache when TTL expires', async () => {
    const providerId = 'mem-ttl-provider';
    let fetchCount = 0;
    registerProvider({
      id: providerId,
      label: providerId,
      fetchModels: async () => {
        fetchCount++;
        return [{ id: `model-${fetchCount}` }];
      },
    });

    try {
      let now = 70_000_000;
      const clock = () => now;

      const first = await fetchModels(
        {
          settingsService: createMockSettingsService(),
          loggingService: { warn: () => {}, debug: () => {} } as any,
          now: clock,
        },
        providerId,
      );
      expect(first[0].id).toBe('model-1');
      expect(fetchCount).toBe(1);

      // Advance time beyond TTL, but do NOT clear memory cache manually
      now += MODEL_CACHE_TTL_MS + 5000;

      // Disk cache also deleted to verify it attempts fresh fetch
      const cacheFilePath = getModelCacheFilePath(providerId);
      if (fs.existsSync(cacheFilePath)) {
        fs.unlinkSync(cacheFilePath);
      }

      const second = await fetchModels(
        {
          settingsService: createMockSettingsService(),
          loggingService: { warn: () => {}, debug: () => {} } as any,
          now: clock,
        },
        providerId,
      );
      expect(second[0].id).toBe('model-2');
      expect(fetchCount).toBe(2);
    } finally {
      unregisterProvider(providerId);
    }
  });
});

describe('isStrictSubsetModels', () => {
  it('returns false when previous list is empty', () => {
    expect(isStrictSubsetModels([{ id: 'm1', provider: 'p' }], [])).toBe(false);
    expect(isStrictSubsetModels([], [])).toBe(false);
  });

  it('returns true when candidate list is empty and previous list is non-empty', () => {
    expect(isStrictSubsetModels([], [{ id: 'm1', provider: 'p' }])).toBe(true);
  });

  it('returns true when candidate list is a non-empty strict subset of previous', () => {
    const prev = [
      { id: 'm1', provider: 'p' },
      { id: 'm2', provider: 'p' },
      { id: 'm3', provider: 'p' },
    ];
    expect(isStrictSubsetModels([{ id: 'm1', provider: 'p' }], prev)).toBe(true);
    expect(
      isStrictSubsetModels(
        [
          { id: 'm2', provider: 'p' },
          { id: 'm3', provider: 'p' },
        ],
        prev,
      ),
    ).toBe(true);
  });

  it('returns false when candidate list has same length as previous', () => {
    const prev = [
      { id: 'm1', provider: 'p' },
      { id: 'm2', provider: 'p' },
    ];
    expect(
      isStrictSubsetModels(
        [
          { id: 'm1', provider: 'p' },
          { id: 'm2', provider: 'p' },
        ],
        prev,
      ),
    ).toBe(false);
  });

  it('returns false when candidate list contains new models not in previous', () => {
    const prev = [
      { id: 'm1', provider: 'p' },
      { id: 'm2', provider: 'p' },
    ];
    // Shorter or same length, but has a new model
    expect(isStrictSubsetModels([{ id: 'm3', provider: 'p' }], prev)).toBe(false);
    expect(
      isStrictSubsetModels(
        [
          { id: 'm1', provider: 'p' },
          { id: 'm3', provider: 'p' },
        ],
        prev,
      ),
    ).toBe(false);
  });
});
