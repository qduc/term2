import http from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelCatalogSession } from '../../../src/model/models/model-catalog-session.js';
import { fetchModels, type FetchModelsDeps } from '../../../src/model/model-service.js';
import { createProviderRegistry } from '../../../src/model/providers/index.js';
import { createOpenAIModelCatalog } from '../../../src/model/providers/openai-model-catalog.js';
import type { ProviderDefinition, ProviderFetch } from '../../../src/model/providers/registry.js';
import type { ISettingsService, ILoggingService } from '../../../src/shared/service-interfaces.js';

let server: http.Server;
let origin: string;
let status: number;
let requests: Array<{ path: string; authorization?: string; contentType?: string }>;
let transport: ProviderFetch;

const loggingService = {
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as ILoggingService;

function deps(key?: string, catalog?: ProviderDefinition['fetchModels']): FetchModelsDeps {
  const registry = createProviderRegistry();
  if (catalog) registry.upsertProvider({ ...registry.getProvider('openai')!, fetchModels: catalog });
  return {
    settingsService: {
      get: (name: string) => (name === 'agent.openai.apiKey' ? key : undefined),
    } as ISettingsService,
    loggingService,
    fetchImpl: transport,
    discovery: {
      providerDefinition: (id) => {
        const provider = registry.getProvider(id);
        if (!provider) throw new Error(`Missing provider ${id}`);
        return provider;
      },
      cache: new Map(),
    },
  };
}

beforeEach(async () => {
  requests = [];
  status = 200;
  server = http.createServer((req, res) => {
    requests.push({
      path: req.url!,
      authorization: req.headers.authorization,
      contentType: req.headers['content-type'],
    });
    if (req.url === '/hang/models') return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ data: [{ id: 'fixture-first' }, { model: 'fixture-second', display_name: 'Second' }, {}] }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  origin = `http://127.0.0.1:${address.port}`;
  // Reject rather than redirect: a hardcoded production URL must fail this test.
  const fixtureFetch = globalThis.fetch;
  transport = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    if (url.origin !== origin) throw new Error(`Unexpected catalog destination: ${url.origin}`);
    return fixtureFetch(input, init);
  };
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-env-key');
  vi.stubEnv('OPENAI_BASE_URL', `${origin}/v1`);
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('loads the registered OpenAI catalog through a session and injected loopback transport', async () => {
  for (const prefix of ['', '/v1', '/gateway/v1/', '/proxy/v1/?tenant=fixture']) {
    vi.stubEnv('OPENAI_BASE_URL', `${origin}${prefix}`);
    const session = new ModelCatalogSession(deps('synthetic-settings-key'));
    const result = await session.load('openai');
    expect(result.kind).toBe('loaded');
    expect(result.models.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'fixture-second', name: 'Second' },
      { id: 'fixture-first', name: undefined },
    ]);
    expect((await session.load('openai')).kind).toBe('cached');
  }
  expect(requests).toEqual(
    ['/models', '/v1/models', '/gateway/v1/models', '/proxy/v1/models?tenant=fixture'].map((path) => ({
      path,
      authorization: 'Bearer synthetic-settings-key',
      contentType: 'application/json',
    })),
  );
});

it('refreshes its injected discovery cache without retaining the previous endpoint catalog', async () => {
  const dependencies = deps();
  const session = new ModelCatalogSession(dependencies);
  await session.load('openai');
  expect(dependencies.discovery!.cache.has('openai')).toBe(true);
  session.refresh('openai');
  expect(dependencies.discovery!.cache.has('openai')).toBe(false);
  await session.load('openai');
  expect(requests).toHaveLength(2);
});

it('keeps environment and absent-key behavior, factory injection, and per-call fetch precedence', async () => {
  const catalog = createOpenAIModelCatalog({ baseURL: `${origin}/injected/`, fetchImpl: transport });
  vi.stubEnv('OPENAI_BASE_URL', 'https://must-not-be-contacted.invalid');
  await catalog(deps());
  vi.stubEnv('OPENAI_API_KEY', '');
  await catalog(deps());
  const broken = async () => {
    throw new Error('Wrong transport');
  };
  await createOpenAIModelCatalog({ baseURL: origin, fetchImpl: broken })(deps(), transport);
  expect(requests.map(({ path, authorization }) => ({ path, authorization }))).toEqual([
    { path: '/injected/models', authorization: 'Bearer synthetic-env-key' },
    { path: '/injected/models', authorization: undefined },
    { path: '/models', authorization: undefined },
  ]);
});

it('preserves a registered factory transport through the session unless explicitly overridden', async () => {
  const factoryFetch = vi.fn(transport);
  const dependencies = deps(
    undefined,
    createOpenAIModelCatalog({ baseURL: `${origin}/factory`, fetchImpl: factoryFetch }),
  );
  delete dependencies.fetchImpl;
  const forbiddenGlobal = vi.fn(async () => {
    throw new Error('Unexpected global fetch fallback');
  });
  vi.stubGlobal('fetch', forbiddenGlobal);
  const session = new ModelCatalogSession(dependencies);
  await session.load('openai');
  expect(factoryFetch).toHaveBeenCalledTimes(1);
  session.refresh('openai');
  const overrideFetch = vi.fn(transport);
  dependencies.fetchImpl = overrideFetch;
  await session.load('openai');
  expect(overrideFetch).toHaveBeenCalledTimes(1);
  expect(factoryFetch).toHaveBeenCalledTimes(1);
  expect(forbiddenGlobal).not.toHaveBeenCalled();
  expect(requests.map(({ path }) => path)).toEqual(['/factory/models', '/factory/models']);
});

it('retains the provider default fetch when neither caller nor factory supplies one', async () => {
  const dependencies = deps();
  delete dependencies.fetchImpl;
  const defaultFetch = vi.fn(transport);
  vi.stubGlobal('fetch', defaultFetch);
  await new ModelCatalogSession(dependencies).load('openai');
  expect(defaultFetch).toHaveBeenCalledTimes(1);
  expect(requests[0].path).toBe('/v1/models');
});

it('preserves the production default without contacting it and allows an explicit model-service transport', async () => {
  vi.stubEnv('OPENAI_BASE_URL', undefined);
  const destinations: string[] = [];
  const recordingTransport: ProviderFetch = async (input, init) => {
    destinations.push(String(input));
    // Only this assertion probe substitutes the destination; the first test never does.
    return transport(`${origin}/default-observation/models`, init);
  };
  const dependencies = deps();
  dependencies.fetchImpl = async () => {
    throw new Error('Wrong transport');
  };
  await fetchModels(dependencies, 'openai', recordingTransport);
  expect(destinations).toEqual(['https://api.openai.com/v1/models']);
  expect(requests[0].path).toBe('/default-observation/models');
});

it('does not fall back to production for invalid endpoints or an HTTP failure', async () => {
  for (const invalid of ['', 'not a url', 'file:///tmp/catalog']) {
    vi.stubEnv('OPENAI_BASE_URL', invalid);
    await expect(new ModelCatalogSession(deps()).load('openai')).rejects.toThrow();
  }
  expect(requests).toHaveLength(0);
  vi.stubEnv('OPENAI_BASE_URL', origin);
  status = 503;
  await expect(new ModelCatalogSession(deps()).load('openai')).rejects.toThrow('OpenAI models request failed (503)');
  expect(requests).toHaveLength(1);
});

it('propagates cancellation across a real pending HTTP catalog request', async () => {
  vi.stubEnv('OPENAI_BASE_URL', `${origin}/hang`);
  const controller = new AbortController();
  const received = new Promise<void>((resolve) => server.once('request', () => resolve()));
  const session = new ModelCatalogSession({ ...deps(), signal: controller.signal });
  const pending = session.load('openai');
  const rejected = expect(pending).rejects.toThrow();
  await received;
  controller.abort();
  await rejected;
  expect(session.getCached('openai')).toBeUndefined();
  expect(requests).toHaveLength(1);
});
