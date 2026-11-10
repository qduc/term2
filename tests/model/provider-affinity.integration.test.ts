import { createServer, type IncomingHttpHeaders } from 'node:http';
import { AsyncResource } from 'node:async_hooks';
import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import { afterEach, expect, it, vi } from 'vitest';
import { createProviderRegistry } from '../../src/model/provider.js';
import { SessionContextService } from '../../src/model/traffic-context.js';
import {
  getProvider,
  getAllProviders,
  createProviderRegistry as createSourceProviderRegistry,
  registerProvider,
  unregisterProvider,
  type ProviderDefinition,
} from '../../src/model/providers/registry.js';
import { OpenAIResponsesModelWithPromptCacheKey } from '../../src/model/providers/openai-responses-model.js';
import {
  OpenAIResponsesModel,
  CodexResponsesWSModel,
  CodexResponsesTransport,
} from '../../src/model/providers/codex-responses-model.js';
import { codexHeadersMiddleware } from '../../src/model/providers/codex.provider.js';
import { buildGrokFetch } from '../../src/model/providers/grok.provider.js';
import type { GrokTokenManager } from '../../src/model/providers/grok-auth.js';
import { OpencodeAnthropicFormatProvider } from '../../src/model/providers/opencode-model-provider.js';
import { generateOpencodeSessionId } from '../../src/model/providers/opencode-session.js';
import { createProviderFetch } from '../../src/model/providers/fetch/composer.js';
import type { SessionTrafficContext } from '../../src/shared/service-interfaces.js';
import { withSessionScope } from '../../src/app/application-models.js';
import { createToolSurface } from '../../src/app/tool-surface.js';
import type { ProfileSelection } from '../../src/app/tool-contract.js';
import type { InteractionRequest } from '../../src/engine/index.js';
import type { Model, ModelAffinity, ModelRequest } from '../../src/model/index.js';
import { createMockSettingsService } from '../helpers/settings-service.mock.js';

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  security() {},
  setCorrelationId() {},
  getCorrelationId: () => undefined,
  clearCorrelationId() {},
};
const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Receipt = { headers: IncomingHttpHeaders; body: Record<string, unknown>; url: string };
async function fixture() {
  const receipts: Receipt[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    receipts.push({ body, headers: request.headers, url: request.url ?? '' });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    if (request.url?.endsWith('/messages')) {
      response.write('event: message_start\n');
      send({
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [],
          model: body.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      });
      response.write('event: content_block_start\n');
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      response.write('event: content_block_delta\n');
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
      response.write('event: content_block_stop\n');
      send({ type: 'content_block_stop', index: 0 });
      response.write('event: message_delta\n');
      send({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      });
      response.write('event: message_stop\n');
      send({ type: 'message_stop' });
    } else if (request.url?.endsWith('/chat/completions')) {
      send({
        id: 'chat_test',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
      });
      send({
        id: 'chat_test',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      response.write('data: [DONE]\n\n');
    } else {
      const compact = (body.input as Array<{ type: string }> | undefined)?.some(
        (item) => item.type === 'compaction_trigger',
      );
      const output = compact
        ? [{ type: 'compaction', id: 'compact', encrypted_content: 'opaque' }]
        : [
            {
              type: 'message',
              id: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok', annotations: [] }],
            },
          ];
      if (compact) send({ type: 'response.output_item.done', output_index: 0, item: output[0] });
      send({
        type: 'response.completed',
        response: {
          id: 'resp_test',
          status: 'completed',
          model: body.model,
          output,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
    }
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  return { receipts, baseURL: `http://127.0.0.1:${address.port}/v1` };
}
function install(definition: ProviderDefinition) {
  const previous = getProvider(definition.id);
  registerProvider(definition, { allowOverride: true });
  cleanups.push(() =>
    previous ? registerProvider(previous, { allowOverride: true }) : unregisterProvider(definition.id),
  );
}
async function collect(model: Model, affinity?: ModelAffinity, overrides: Partial<ModelRequest> = {}) {
  const events = [];
  let dispatches = 0;
  for await (const event of model.stream(
    { model: model.ref, input: [], instructions: 'test', tools: [], ...(affinity ? { affinity } : {}), ...overrides },
    new AbortController().signal,
    () => dispatches++,
  ))
    events.push(event);
  expect(events.at(-1)?.type).toBe('done');
  expect(dispatches).toBe(1);
}

it('carries tool suppression to OpenRouter and compatible HTTP requests without changing ordinary turns', async () => {
  const { receipts, baseURL } = await fixture();
  const settings = createMockSettingsService({
    'agent.retryAttempts': 0,
    'agent.openrouter.apiKey': 'fixture',
    'agent.openrouter.baseUrl': baseURL,
    providers: [{ name: 'tool-choice-fixture', type: 'openai-compatible', baseUrl: baseURL, apiKey: 'fixture' }],
  });
  const registry = createProviderRegistry({ settings, logger });
  for (const provider of ['openrouter', 'tool-choice-fixture']) {
    const model = registry.resolve({ provider, model: 'fixture' });
    const request = {
      model: model.ref,
      instructions: 'Summarize without actions.',
      input: [],
      tools: [{ name: 'fixture_tool', description: 'Keep this schema.', inputSchema: { type: 'object' } }],
    };
    await collect(model, undefined, { ...request, toolChoice: 'none' });
    expect(receipts.at(-1)!.body).toMatchObject({
      tool_choice: 'none',
      tools: [{ function: { name: 'fixture_tool' } }],
    });
    await collect(model, undefined, request);
    expect(receipts.at(-1)!.body).not.toHaveProperty('tool_choice');
    expect(receipts.at(-1)!.body).toHaveProperty('tools');
  }
});

it('uses explicit request affinity across cached provider adapters and independent ambient sessions', async () => {
  const { receipts, baseURL } = await fixture();
  const cache = await mkdtemp(path.join(tmpdir(), 'grok-affinity-'));
  cleanups.push(() => rm(cache, { recursive: true, force: true }));
  await writeFile(
    path.join(cache, 'grok-client-version.json'),
    JSON.stringify({ version: '1.0.62', timestamp: Date.now() }),
  );
  vi.stubEnv('TERM2_CACHE_DIR', cache);
  const settings = createMockSettingsService({ 'agent.transport': 'http', 'agent.retryAttempts': 0 });
  const ambient = new SessionContextService();
  const cases = ['responses', 'grok', 'opencode-responses', 'opencode-chat', 'opencode-anthropic', 'codex-ws'];
  for (const kind of cases) {
    const id = kind === 'codex-ws' ? 'codex' : `affinity-${kind}`;
    const metadata: SessionTrafficContext[] = [];
    install({
      id,
      label: id,
      fetchModels: async () => [],
      capabilities: {
        supportsConversationChaining: false,
        supportsPromptCacheKey: true,
        promptCacheKeyPlacement: kind === 'codex-ws' ? 'codex' : 'responses-extra-body',
      },
      createStreamedModel(model, deps) {
        const recordingFetch: typeof fetch = (input, init) => {
          const context = deps.sessionContextService?.getContext();
          if (context) metadata.push({ ...context });
          return fetch(input, init);
        };
        const providerFetch = createProviderFetch({
          providerId: id,
          defaultModel: model,
          deps,
          fetchImpl: recordingFetch,
          middlewares: kind === 'codex-ws' ? [codexHeadersMiddleware(deps.sessionContextService)] : [],
        });
        if (kind.startsWith('opencode'))
          return new OpencodeAnthropicFormatProvider(
            { name: id, type: 'opencode', baseUrl: baseURL, apiKey: 'fixture' },
            {
              defaultModel: model,
              settingsService: settings,
              loggingService: logger,
              sessionContextService: deps.sessionContextService,
              fetch: recordingFetch,
              onDispatched: deps.onDispatched,
            },
          ).getStreamedModel(model);
        if (kind === 'codex-ws') {
          const client = new OpenAI({
            apiKey: 'fixture',
            baseURL,
            maxRetries: 0,
            fetch: providerFetch,
          });
          const transport = new CodexResponsesTransport(client, model, false);
          return new CodexResponsesWSModel(
            client,
            model,
            {
              getOrRefreshAccessToken: async () => 'fixture',
              getAccountId: () => undefined,
              getInstallationId: () => 'fixture',
            },
            undefined,
            undefined,
            deps.sessionContextService,
            transport,
          );
        }
        let selectedFetch = providerFetch;
        if (kind === 'grok') {
          const grokFetch = buildGrokFetch(
            deps,
            { getOrRefreshAccessToken: async () => 'fixture' } as GrokTokenManager,
            model,
          );
          selectedFetch = (input, init) => {
            const context = deps.sessionContextService?.getContext();
            if (context) metadata.push({ ...context });
            return grokFetch(input, init);
          };
        }
        const client = new OpenAI({ apiKey: 'fixture', baseURL, maxRetries: 0, fetch: selectedFetch });
        return new OpenAIResponsesModelWithPromptCacheKey(client, model);
      },
    });
    const registry = createProviderRegistry({
      settings,
      logger,
      sessionContext: ambient,
      providers: { getAllProviders },
    });
    const name = kind === 'opencode-anthropic' ? 'qwen-test' : kind === 'opencode-chat' ? 'deepseek-test' : 'gpt-test';
    const model = registry.resolve({ provider: id, model: name });
    const before = receipts.length;
    await Promise.all(
      ['one', 'two'].map((key) =>
        ambient.runWithContext(
          {
            sessionId: `wrong-${key}`,
            sessionStartedAt: `started-${key}`,
            promptCacheKey: `wrong-cache-${key}`,
            mode: `mode-${key}`,
            traceId: `trace-${key}`,
            firstUserMessagePreview: `preview-${key}`,
            evaluator: true,
            rootContextCompaction: true,
          },
          () =>
            collect(model, { conversationKey: `logical-${key}`, cacheKey: `cache-${key}`, routingKey: `route-${key}` }),
        ),
      ),
    );
    const actual = receipts.slice(before);
    expect(actual).toHaveLength(2);
    expect(metadata.map((context) => context.sessionStartedAt).sort()).toEqual(['started-one', 'started-two']);
    expect(metadata.map((context) => context.mode).sort()).toEqual(['mode-one', 'mode-two']);
    expect(metadata.map((context) => context.traceId).sort()).toEqual(['trace-one', 'trace-two']);
    expect(metadata.map((context) => context.firstUserMessagePreview).sort()).toEqual(['preview-one', 'preview-two']);
    expect(
      actual.every((receipt) => receipt.body.affinity === undefined && receipt.body.onDispatched === undefined),
    ).toBe(true);
    if (kind.startsWith('opencode'))
      expect(actual.map((r) => r.headers['x-opencode-session']).sort()).toEqual(
        ['one', 'two'].map((key) => generateOpencodeSessionId(`route-${key}`)).sort(),
      );
    else if (kind === 'grok')
      expect(actual.map((r) => r.headers['x-grok-conv-id']).sort()).toEqual(['route-one', 'route-two']);
    else if (kind === 'codex-ws')
      expect(actual.map((r) => r.headers['session-id']).sort()).toEqual(['route-one', 'route-two']);
    if (!kind.startsWith('opencode') || kind === 'opencode-responses')
      expect(actual.map((r) => r.body.prompt_cache_key).sort()).toEqual(['cache-one', 'cache-two']);
    // Reusing the model without identity must not inherit either caller's ambient session.
    if (kind === 'grok' || kind.startsWith('opencode') || kind === 'codex-ws') {
      const unscoped = receipts.length;
      await ambient.runWithContext(
        { sessionId: 'wrong-root', sessionStartedAt: '', promptCacheKey: 'wrong-root' },
        () => Promise.all([collect(model), collect(model)]),
      );
      const header = kind === 'grok' ? 'x-grok-conv-id' : kind === 'codex-ws' ? 'session-id' : 'x-opencode-session';
      const keys = receipts.slice(unscoped).map((r) => r.headers[header]);
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBeTruthy();
      expect(keys[0]).not.toBe(keys[1]);
      expect(keys).not.toContain('wrong-root');
    }
  }
});

it('carries root identity through native compaction and honors explicit isolated history/routing', async () => {
  const { receipts, baseURL } = await fixture();
  install({
    id: 'codex',
    label: 'codex',
    fetchModels: async () => [],
    capabilities: {
      supportsConversationChaining: false,
      supportsPromptCacheKey: true,
      promptCacheKeyPlacement: 'codex',
    },
    createStreamedModel(model, deps) {
      const client = new OpenAI({
        apiKey: 'fixture',
        baseURL,
        maxRetries: 0,
        fetch: createProviderFetch({
          providerId: 'codex',
          defaultModel: model,
          deps,
          middlewares: [codexHeadersMiddleware(deps.sessionContextService)],
        }),
      });
      return new OpenAIResponsesModel(client, model);
    },
  });
  const ambient = new SessionContextService();
  const registry = createProviderRegistry({
    settings: createMockSettingsService({ 'agent.transport': 'http' }),
    providers: { getAllProviders },
    logger,
    sessionContext: ambient,
  });
  const identity = { conversationKey: 'rotated-history', cacheKey: 'stable-root', routingKey: 'stable-route' };
  const scoped = withSessionScope(
    registry,
    (fn) => ambient.runWithContext({ sessionId: 'wrong-root', sessionStartedAt: '' }, fn),
    identity,
  );
  const model = scoped.resolve({ provider: 'codex', model: 'gpt-test' });
  const request = { model: model.ref, input: [], instructions: 'test', tools: [] };
  expect(await model.compact!(request, new AbortController().signal)).not.toHaveLength(0);
  expect(receipts.at(-1)?.headers['session-id']).toBe('stable-route');
  expect(JSON.parse(String(receipts.at(-1)?.headers['x-codex-turn-metadata'])).session_id).toBe('rotated-history');
  await model.compact!(
    { ...request, affinity: { conversationKey: 'child-history', routingKey: 'child-route' } },
    new AbortController().signal,
  );
  expect(receipts.at(-1)?.headers['session-id']).toBe('child-route');
});

it('gives approval advisory requests their own explicit affinity without an ambient session', async () => {
  const { receipts, baseURL } = await fixture();
  const id = 'affinity-advisory';
  install({
    id,
    label: id,
    fetchModels: async () => [],
    capabilities: {
      supportsConversationChaining: false,
      supportsPromptCacheKey: true,
      promptCacheKeyPlacement: 'responses-extra-body',
    },
    createStreamedModel(model) {
      return new OpenAIResponsesModelWithPromptCacheKey(
        new OpenAI({ apiKey: 'fixture', baseURL, maxRetries: 0 }),
        model,
      );
    },
  });
  const workspace = await mkdtemp(path.join(tmpdir(), 'advisory-affinity-'));
  cleanups.push(() => rm(workspace, { recursive: true, force: true }));
  const settings = createMockSettingsService({
    'agent.modelSelection': { provider: id, model: 'gpt-test' },
    'agent.retryAttempts': 0,
    'shell.autoApproveMode': 'advisory',
    'agent.decisionModel': undefined,
  });
  const surface = createToolSurface(
    {
      settings,
      logger: logger as unknown as ProfileSelection['logger'],
      sessionContext: new SessionContextService(),
      providers: { getAllProviders },
    },
    {
      workspace: { root: workspace, target: 'local', access: 'read_write' },
      affinity: { conversationKey: 'root-advisory', cacheKey: 'root-cache' },
    },
  );
  cleanups.push(() => surface.runtime.dispose?.());
  await surface.decideInteraction(
    {
      kind: 'approval',
      toolName: 'create_file',
      input: { path: 'example.txt', content: 'test' },
      summary: 'Create a file',
      requestId: 'approval' as InteractionRequest['requestId'],
      turnId: 'turn' as InteractionRequest['turnId'],
    },
    [],
  );
  expect(receipts.length).toBeGreaterThan(0);
  expect(receipts.every((receipt) => receipt.body.prompt_cache_key === 'root-advisory:evaluator')).toBe(true);
});

it('notifies the correct request when a real WebSocket opens outside the request async scope', async () => {
  const http = createServer();
  const websocket = new WebSocketServer({ noServer: true });
  const upgrades: Array<() => void> = [];
  let allUpgrades: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    allUpgrades = resolve;
  });
  http.on('upgrade', (request, socket, head) => {
    upgrades.push(() =>
      websocket.handleUpgrade(request, socket, head, (client) => {
        client.on('message', () =>
          client.send(
            JSON.stringify({
              type: 'response.completed',
              response: { id: 'response', status: 'completed', output: [] },
            }),
          ),
        );
      }),
    );
    if (upgrades.length === 2) allUpgrades();
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    for (const client of websocket.clients) client.terminate();
    await new Promise<void>((resolve) => websocket.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const outside = new AsyncResource('independent-websocket-open');
  cleanups.push(() => {
    outside.emitDestroy();
  });
  // The SDK imports ws directly; stubbing globalThis.WebSocket misses this path.
  const emit = NodeWebSocket.prototype.emit;
  vi.spyOn(NodeWebSocket.prototype, 'emit').mockImplementation(function (
    this: NodeWebSocket,
    event: string | symbol,
    ...args: unknown[]
  ) {
    if (event === 'open') return outside.runInAsyncScope(() => emit.call(this, event, ...args));
    return emit.call(this, event, ...args);
  });
  install({
    id: 'codex',
    label: 'codex',
    fetchModels: async () => [],
    capabilities: { supportsConversationChaining: false, supportsPromptCacheKey: true },
    createStreamedModel(model, deps) {
      const client = new OpenAI({ apiKey: 'fixture', baseURL: `http://127.0.0.1:${address.port}/v1`, timeout: 2000 });
      const transport = new CodexResponsesTransport(client, model, true);
      cleanups.push(() => transport.close());
      return new CodexResponsesWSModel(
        client,
        model,
        {
          getOrRefreshAccessToken: async () => 'fixture',
          getAccountId: () => undefined,
          getInstallationId: () => undefined,
        },
        undefined,
        undefined,
        deps.sessionContextService,
        transport,
      );
    },
  });
  const registry = createProviderRegistry({
    settings: createMockSettingsService({ 'agent.transport': 'websocket', 'agent.retryAttempts': 0 }),
    providers: { getAllProviders },
    logger,
  });
  const model = registry.resolve({ provider: 'codex', model: 'gpt-5.3-codex' });
  const completed = Promise.all(
    ['first', 'second'].map((key) => collect(model, { conversationKey: key, cacheKey: key })),
  );
  // Hold the HTTP upgrades until both transports have installed their deferred
  // socket-open callbacks. Emit the client event from an unrelated async scope.
  await ready;
  outside.runInAsyncScope(() => upgrades.forEach((upgrade) => upgrade()));
  await completed;
});

it('keeps provider registrations local to the registry generation that captured them', async () => {
  const { receipts, baseURL } = await fixture();
  const id = 'affinity-provider-snapshot';
  const definition = (wireModel: string): ProviderDefinition => ({
    id,
    label: id,
    fetchModels: async () => [],
    createStreamedModel(_model, deps) {
      return new OpenAIResponsesModelWithPromptCacheKey(
        new OpenAI({
          apiKey: 'fixture',
          baseURL,
          maxRetries: 0,
          fetch: createProviderFetch({ providerId: id, defaultModel: wireModel, deps }),
        }),
        wireModel,
      );
    },
  });
  const settings = createMockSettingsService({ 'agent.retryAttempts': 0 });
  const providers = createSourceProviderRegistry();
  providers.registerProvider(definition('first-generation'));
  const first = createProviderRegistry({ settings, logger, providers });
  providers.upsertProvider(definition('second-generation'));
  const second = createProviderRegistry({ settings, logger, providers });
  await collect(first.resolve({ provider: id, model: 'gpt-test' }));
  await collect(second.resolve({ provider: id, model: 'gpt-test' }));
  expect(receipts.map((receipt) => receipt.body.model)).toEqual(['first-generation', 'second-generation']);
});

it('derives custom providers from each instance settings and excludes another host runtime registrations', async () => {
  const firstWire = await fixture();
  const secondWire = await fixture();
  const id = 'affinity-local-custom';
  install({
    id,
    label: id,
    fetchModels: async () => [],
    createStreamedModel() {
      throw new Error('Global runtime provider must not be used');
    },
  });
  const unconfigured = createProviderRegistry({ settings: createMockSettingsService(), logger });
  expect(() => unconfigured.resolve({ provider: id, model: 'gpt-test' })).toThrow('does not expose');
  const configured = (baseUrl: string) =>
    createMockSettingsService({
      'agent.retryAttempts': 0,
      providers: [{ id, name: id, type: 'openai-compatible', baseUrl, apiKey: 'fixture' }],
    });
  const firstSettings = configured(firstWire.baseURL);
  const secondSettings = configured(secondWire.baseURL);
  const first = createProviderRegistry({ settings: firstSettings, logger });
  const second = createProviderRegistry({ settings: secondSettings, logger });
  await Promise.all([
    collect(first.resolve({ provider: id, model: 'gpt-test' })),
    collect(second.resolve({ provider: id, model: 'gpt-test' })),
  ]);
  expect(firstWire.receipts).toHaveLength(1);
  expect(secondWire.receipts).toHaveLength(1);
});
