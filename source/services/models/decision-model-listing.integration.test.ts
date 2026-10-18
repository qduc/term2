import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { clearDecisionModelListCache, fetchDecisionModels } from './decision-model-listing.js';

let server: Server;
let fixtureUrl: string;
let status: number;
let payload: unknown;
let requests: string[];
const realFetch = globalThis.fetch;
const fixtureFetch: typeof fetch = async (url, init) => {
  requests.push(String(url));
  return realFetch(fixtureUrl, init);
};

beforeEach(async () => {
  clearDecisionModelListCache();
  requests = [];
  status = 200;
  payload = { data: [{ id: 'decision-model', name: 'Decision model' }, { id: '' }, null] };
  server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixtureUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  clearDecisionModelListCache();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

it('loads the provider catalog through HTTP and caches only a validated success', async () => {
  const options = { fetchImpl: fixtureFetch, ttlMs: 100, now: () => 1000 };
  const models = [{ id: 'decision-model', name: 'Decision model' }];
  expect(await fetchDecisionModels(options)).toEqual(models);
  status = 503;
  expect(await fetchDecisionModels(options)).toEqual(models);
  expect(requests).toEqual(['https://openrouter.ai/api/v1/models?output_modalities=decisions']);
  expect(await fetchDecisionModels({ ...options, now: () => 1100 })).toBeNull();
  status = 200;
  expect(await fetchDecisionModels({ ...options, now: () => 1101 })).toEqual(models);
  expect(requests).toHaveLength(3);
});

it('retries malformed provider catalogs without preserving the failure', async () => {
  payload = { data: 'invalid' };
  expect(await fetchDecisionModels({ fetchImpl: fixtureFetch })).toBeNull();
  payload = { data: [{ id: 'recovered' }] };
  expect(await fetchDecisionModels({ fetchImpl: fixtureFetch })).toEqual([{ id: 'recovered' }]);
  expect(requests).toHaveLength(2);
});
