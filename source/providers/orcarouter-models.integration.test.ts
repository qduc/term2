import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { unregisterProvider } from './registry.js';
import type { ProviderFetch } from './registry.js';
import type { ILoggingService } from '../services/service-interfaces.js';
import { SettingsService } from '../services/settings/settings-service.js';
import type { KnownCustomProviderType } from '../services/settings/settings-schema.js';
import { clearModelMemoryCacheForTest, fetchModels, getModelCacheFilePath } from '../services/model-service.js';

const catalog = [
  { id: 'chat', supported_endpoint_types: ['openai', 'anthropic', 'gemini'] },
  {
    id: 'vision',
    supported_endpoint_types: ['openai', 'anthropic', 'gemini'],
    architecture: { input_modalities: ['text', 'image', 'video'], output_modalities: ['text'] },
  },
  { id: 'minimal' },
  { id: 'image', supported_endpoint_types: ['image-generation'] },
  { id: 'video', supported_endpoint_types: ['openai-video'] },
  { id: 'embedding', supported_endpoint_types: ['embeddings'] },
  { id: 'unadvertised', supported_endpoint_types: null },
  { id: 'empty', supported_endpoint_types: [] },
  {
    id: 'mixed-output',
    supported_endpoint_types: ['openai', 'anthropic', 'gemini'],
    architecture: { output_modalities: ['text', 'image'] },
  },
];

let tempDir: string;
let server: http.Server;
let fixtureUrl: string;
let status: number;
let requestedUrls: string[];
let providerNumber = 0;
const registeredIds: string[] = [];
const loggingService: ILoggingService = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  security: vi.fn(),
  setCorrelationId: vi.fn(),
  getCorrelationId: () => undefined,
  clearCorrelationId: vi.fn(),
};

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-orca-adapter-'));
  status = 200;
  requestedUrls = [];
  server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: catalog, models: catalog.map((item) => ({ ...item, baseModelId: item.id })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  fixtureUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  for (const id of registeredIds.splice(0)) unregisterProvider(id);
  clearModelMemoryCacheForTest();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function listModels(baseUrl: string, type: KnownCustomProviderType = 'openai-compatible', seedOldCache = false) {
  const id = `renamed-provider-${++providerNumber}`;
  const config = { id, name: id, type, baseUrl, apiKey: 'fixture-key' };
  const settingsService = new SettingsService({
    settingsDir: tempDir,
    disableLogging: true,
    disableFilePersistence: true,
    cli: { providers: [config] },
  });
  registeredIds.push(id);
  const cacheFile = getModelCacheFilePath(id, tempDir);
  if (seedOldCache) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 2,
        provider: id,
        timestamp: Date.now(),
        models: catalog.map((item) => ({ id: item.id, provider: id })),
      }),
    );
  }
  // Redirect only the external network boundary; adapter selection and the
  // registry, model service, HTTP exchange and disk cache are real.
  const fetchFixture: ProviderFetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    requestedUrls.push(url.toString());
    return fetch(`${fixtureUrl}${url.pathname}${url.search}`, init);
  };
  const models = await fetchModels({ settingsService, loggingService, cacheDir: tempDir }, id, fetchFixture);
  return { ids: models.map((model) => model.id), cacheFile };
}

it.each(['openai-compatible', 'openai', 'anthropic', 'google'] as const)(
  'selects the OrcaRouter adapter by hostname for a renamed %s provider',
  async (type) => {
    const { ids, cacheFile } = await listModels('https://API.OrcaRouter.ai/v1', type, true);
    expect(ids).toEqual(['chat', 'vision', 'minimal']);
    expect(requestedUrls).toHaveLength(1);
    expect(new URL(requestedUrls[0]!).hostname).toBe('api.orcarouter.ai');
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    expect(cache.version).toBe(3);
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(ids);
  },
);

it.each([
  'https://other.example/v1',
  'https://api.orcarouter.ai.other.example/v1',
  'https://other.example/api.orcarouter.ai/v1',
  'https://api.orcarouter.ai@other.example/v1',
])('does not apply OrcaRouter metadata semantics to %s', async (baseUrl) => {
  const { ids } = await listModels(baseUrl);
  expect(ids).toEqual(catalog.map((model) => model.id));
});

it('does not restore a pre-adapter catalog when the OrcaRouter endpoint fails', async () => {
  status = 503;
  await expect(listModels('https://api.orcarouter.ai/v1', 'openai-compatible', true)).rejects.toThrow('503');
  expect(requestedUrls).toHaveLength(1);
});
