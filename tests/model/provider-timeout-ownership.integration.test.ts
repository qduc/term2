import { once } from 'node:events';
import { createServer } from 'node:http';
import OpenAI from 'openai';
import { expect, it } from 'vitest';
import { withGenerationGuard } from '../../src/app/generation-guard.js';
import type { ProfileSelection } from '../../src/app/tool-contract.js';
import type { Model, ModelRef, ModelRequest } from '../../src/model/index.js';
import { CodexResponsesTransport } from '../../src/model/providers/codex-responses-model.js';
import { createProviderFetch } from '../../src/model/providers/fetch/composer.js';
import type { ILoggingService } from '../../src/shared/service-interfaces.js';

it('hands a guarded SSE stall to the application but still times out stalled Codex compaction', async () => {
  // Give plain fetch a short real socket-body timeout instead of waiting five minutes.
  new Headers();
  const key = Symbol.for('undici.globalDispatcher.1');
  const globals = globalThis as Record<symbol, unknown>;
  const original = globals[key];
  const Agent = (original as object).constructor as new (options: { bodyTimeout: number }) => {
    destroy(): Promise<void>;
  };
  const agent = new Agent({ bodyTimeout: 100 });
  globals[key] = agent;
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.flushHeaders();
  });

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP address');
    const client = new OpenAI({
      apiKey: 'fixture',
      baseURL: `http://127.0.0.1:${address.port}`,
      maxRetries: 0,
      fetch: createProviderFetch({
        providerId: 'codex',
        defaultModel: 'fixture',
        deps: { loggingService: {} as ILoggingService },
      }),
    });
    const transport = new CodexResponsesTransport(client, 'fixture');
    const ref: ModelRef = { provider: 'codex', model: 'fixture' };
    const model: Model = {
      ref,
      contextWindow: 128_000,
      async *stream(_request, signal) {
        const events = await client.responses.create({ model: 'fixture', input: 'fixture', stream: true }, { signal });
        for await (const _event of events) {
          yield { type: 'text_delta', delta: 'fixture' };
        }
      },
      async compact(_request, signal) {
        await transport.compactHistory({ input: [], signal });
        return [];
      },
    };
    const settings = {
      get: (key: string) => (key === 'agent.maxModelStreamIdleMs' ? 2_500 : undefined),
    } as ProfileSelection['settings'];
    const guarded = withGenerationGuard({ list: () => [], resolve: () => model }, {
      settings,
    } as ProfileSelection).resolve(ref);
    const request = { input: [] } as unknown as ModelRequest;
    const cleanup = new AbortController();
    const signal = AbortSignal.any([cleanup.signal, AbortSignal.timeout(5_000)]);

    try {
      await Promise.all([
        expect(guarded.stream(request, signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({
          code: 'stream_inactivity',
        }),
        expect(guarded.compact!(request, signal)).rejects.toMatchObject({ cause: { code: 'UND_ERR_BODY_TIMEOUT' } }),
      ]);
    } finally {
      cleanup.abort();
    }
  } finally {
    globals[key] = original;
    await agent.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
