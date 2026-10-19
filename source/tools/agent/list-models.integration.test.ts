import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createListModelsToolDefinition, modelDiscoveryResultSchema } from './list-models.js';
import { clearModelMemoryCacheForTest } from '../../services/model-service.js';
import { SettingsService } from '../../services/settings/settings-service.js';
import { SessionIndexService } from '../../services/conversation/session-index/session-index-service.js';
import { createConversationLogWriter } from '../../services/logging/conversation-log-writer.js';
import { registerProvider, unregisterProvider } from '../../providers/index.js';
import type { ILoggingService } from '../../services/service-interfaces.js';

const directories: string[] = [];
const logger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  getCorrelationId: () => undefined,
} as unknown as ILoggingService;
const ids = ['discovery-fixture', 'discovery-failure', 'discovery-disabled'];
afterEach(() => {
  clearModelMemoryCacheForTest();
  vi.useRealTimers();
  for (const id of ids) unregisterProvider(id);
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('avoids unused I/O, overlaps catalog loads, and retrieves compact pages without losing models', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'term2-discovery-pages-'));
  directories.push(dir);
  const settings = new SettingsService({ settingsDir: dir, disableLogging: true });
  for (const id of ids)
    registerProvider({
      id,
      label: id,
      fetchModels: async () => [],
      createStreamedModel: () => {
        throw new Error('not invoked');
      },
    });
  let historyCalls = 0;
  let active = 0;
  let peak = 0;
  const catalogCalls: string[] = [];
  const tool = createListModelsToolDefinition({
    settingsService: settings,
    loggingService: logger,
    getHistory: async () => {
      historyCalls++;
      return { sessions: [], scope: dir, total: 0, unavailable: 0 };
    },
    catalogDeps: {
      fetcher: async (provider) => {
        catalogCalls.push(provider);
        peak = Math.max(peak, ++active);
        await Promise.resolve();
        active--;
        return Array.from({ length: 120 }, (_, n) => ({ provider, id: `model-${n}`, name: `Display ${n}` }));
      },
    },
  });
  const call = async (params: Parameters<typeof tool.execute>[0]) =>
    modelDiscoveryResultSchema.parse(await tool.execute(params));
  const providers = await call({ view: 'providers', provider_query: 'discovery-' });
  expect(providers.providers).toHaveLength(3);
  expect(providers.history.status).toBe('not-requested');
  expect(catalogCalls).toHaveLength(0);
  expect(historyCalls).toBe(0);
  const first = await call({ provider_query: 'fixture', sort: 'name' });
  expect(catalogCalls).toEqual(['discovery-fixture']);
  expect(historyCalls).toBe(0);
  expect(first.history.status).toBe('not-requested');
  expect(first.models).toHaveLength(50);
  expect(first.totalModels).toBe(120);
  expect(first.nextOffset).toBe(50);
  expect(first.models[0]).not.toHaveProperty('name');
  const second = await call({ provider: ids[0], sort: 'name', offset: first.nextOffset! });
  const third = await call({ provider: ids[0], sort: 'name', offset: second.nextOffset! });
  expect(second.models).toHaveLength(50);
  expect(third.models).toHaveLength(20);
  expect(third.nextOffset).toBeNull();
  expect(new Set([...first.models, ...second.models, ...third.models].map((m) => m.id)).size).toBe(120);
  const named = await call({ provider: ids[0], sort: 'name', include_names: true, query: 'Display 119' });
  expect(named.models[0]?.name).toBe('Display 119');
  const beyond = await call({ provider: ids[0], sort: 'name', offset: 120 });
  expect(beyond.models).toHaveLength(0);
  expect(beyond.nextOffset).toBeNull();
  const all = await call({ provider: ids[0], sort: 'name', limit: 121, include_history: true });
  expect(all.models).toHaveLength(120);
  expect(all.nextOffset).toBeNull();
  expect(historyCalls).toBe(1);
  catalogCalls.length = 0;
  await call({ provider_query: 'discovery-', sort: 'recency', include_history: false });
  expect(new Set(catalogCalls)).toEqual(new Set(ids));
  expect(peak).toBe(3);
  expect(historyCalls).toBe(1);
});

it('discovers registry IDs, sorts real saved session associations, and never exposes history content or errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'term2-discovery-'));
  directories.push(dir);
  const settings = new SettingsService({ settingsDir: join(dir, 'settings'), disableLogging: true });
  settings.set('agent.disabledProviders', ['discovery-disabled']);
  for (const id of ids)
    registerProvider({
      id,
      label: id,
      createStreamedModel: () => {
        throw new Error('must not invoke a model');
      },
      fetchModels: async () => {
        if (id === 'discovery-failure') throw new Error('secret-provider-error');
        return [{ id: 'frequent' }, { id: 'recent' }, { id: 'unused' }];
      },
    });
  vi.useFakeTimers({ toFake: ['Date'] });
  for (const [id, model, createdAt, projectPath] of [
    ['old-one', 'frequent', '2026-01-01T00:00:00Z', dir],
    ['old-two', 'frequent', '2026-01-02T00:00:00Z', dir],
    ['new-one', 'recent', '2026-03-01T00:00:00Z', dir],
    ['other-project', 'unused', '2026-04-01T00:00:00Z', '/outside-discovery-fixture'],
  ]) {
    vi.setSystemTime(new Date(createdAt!));
    const writer = createConversationLogWriter({ sessionId: id!, dir, logger });
    writer.init({ id: id!, model, provider: ids[0], createdAt: new Date(createdAt!).toISOString(), projectPath });
    writer.append({
      type: 'user_message',
      message: { id: `${id}-u`, sender: 'user', text: 'private-conversation-content' },
    });
    await writer.close();
  }
  vi.useRealTimers();
  const index = new SessionIndexService({ backend: 'direct', dbPath: join(dir, 'index.db'), conversationsDir: dir });
  try {
    const tool = createListModelsToolDefinition({
      settingsService: settings,
      loggingService: logger,
      getHistory: () => index.list({ projectPath: dir }),
      catalogDeps: { cacheDir: dir },
    });
    const usage = modelDiscoveryResultSchema.parse(await tool.execute({ provider: ids[0], sort: 'usage' }));
    expect(usage.history.status).toBe('available');
    expect(
      usage.models.filter((m: { provider: string }) => m.provider === ids[0]).map((m) => [m.id, m.sessionCount]),
    ).toEqual([
      ['frequent', 2],
      ['recent', 1],
      ['unused', 0],
    ]);
    const recency = modelDiscoveryResultSchema.parse(await tool.execute({ provider: ids[0], sort: 'recency' }));
    expect(recency.models[0].id).toBe('recent');
    const failed = modelDiscoveryResultSchema.parse(await tool.execute({ provider: ids[1] }));
    const disabled = modelDiscoveryResultSchema.parse(await tool.execute({ provider: ids[2] }));
    expect(failed.providers[0].catalogStatus).toBe('failed');
    expect(disabled.providers[0].catalogStatus).toBe('not-ready');
    expect(JSON.stringify(usage)).not.toContain('private-conversation-content');
    expect(JSON.stringify(failed)).not.toContain('secret-provider-error');
    const unknown = createListModelsToolDefinition({
      settingsService: settings,
      loggingService: logger,
      getHistory: async () => {
        throw new Error('secret-history-path');
      },
      catalogDeps: { cacheDir: dir },
    });
    const noHistory = modelDiscoveryResultSchema.parse(await unknown.execute({ provider: ids[0], query: 'recent' }));
    expect(noHistory.history.status).toBe('unavailable');
    expect(noHistory.models).toHaveLength(1);
    expect(noHistory.models[0].sessionCount).toBeNull();
    expect(JSON.stringify(noHistory)).not.toContain('secret-history-path');
  } finally {
    await index.close();
  }
});

it('forwards runtime cancellation to an in-flight provider catalog request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'term2-discovery-abort-'));
  directories.push(dir);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('[');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture address');
  const settings = new SettingsService({ settingsDir: dir, disableLogging: true });
  registerProvider({
    id: ids[0]!,
    label: 'Abort fixture',
    createStreamedModel: () => {
      throw new Error('not invoked');
    },
    fetchModels: async (deps) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/models`, { signal: deps.signal });
      return (await response.json()) as Array<{ id: string }>;
    },
  });
  const controller = new AbortController();
  try {
    const tool = createListModelsToolDefinition({
      settingsService: settings,
      loggingService: logger,
      catalogDeps: { cacheDir: dir },
    });
    const requestStarted = once(server, 'request');
    const pending = tool.execute({ provider: ids[0], sort: 'name' }, { signal: controller.signal });
    await requestStarted;
    controller.abort();
    const result = modelDiscoveryResultSchema.parse(await pending);
    expect(result.providers[0]?.catalogStatus).toBe('failed');
    expect(result.models).toEqual([]);
    expect(result.history.status).toBe('not-requested');
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
