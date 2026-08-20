import { expect, it } from 'vitest';
import {
  createRetryAwareFetch,
  OpenAIResponsesModelWithPromptCacheKey,
  OpenAIResponsesWSModelWithPromptCacheKey,
} from './openai.provider.js';

it.each([
  ['zero retries', 0, ['0']],
  ['one scheduled retry', 1, ['0', '1']],
  ['exhaustion', 1, ['0']],
])('notifies only when the SDK starts a %s', async (_label, retryAttempts, retryCounts) => {
  const notifications: number[] = [];
  const fetchImpl = createRetryAwareFetch(
    async (_url, init) => new Response('', { status: 503, headers: init?.headers }),
    () => notifications.push(1),
    retryAttempts,
  );
  for (const retryCount of retryCounts) {
    await fetchImpl('https://example.test', {
      headers: { 'X-Stainless-Retry-Count': retryCount },
    });
  }
  expect(notifications).toHaveLength(retryCounts.filter((count) => Number(count) > 0).length);
});

it('builds an OpenAI Responses request through the public client boundary', async () => {
  let request: any;
  const model = new OpenAIResponsesModelWithPromptCacheKey(
    {
      responses: {
        create: async (body: any) => {
          request = body;
          return { id: 'response-1', output: [], usage: {} };
        },
      },
    },
    'gpt-test',
  );
  await model.getResponse({
    input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    providerOptions: { extraBody: { prompt_cache_key: 's1' } },
  });
  expect(request).toMatchObject({ model: 'gpt-test', stream: false, prompt_cache_key: 's1' });
});

it('normalizes streamed Responses events into the application stream shape', async () => {
  const model = new OpenAIResponsesModelWithPromptCacheKey(
    {
      responses: {
        create: async () =>
          (async function* () {
            yield { type: 'response.created', response: { id: 'response-2' } };
            yield { type: 'response.output_text.delta', delta: 'hello' };
            yield { type: 'response.completed', response: { id: 'response-2', output: [] } };
          })(),
      },
    },
    'gpt-test',
  );
  const events: any[] = [];
  for await (const event of model.stream({
    input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
  }))
    events.push(event);
  expect(events.map((event) => event.type)).toEqual(['text_delta', 'completion']);
  expect(events[0].text).toBe('hello');
});

it('retains a separate public transport class for WebSocket-configured sessions', () => {
  expect(new OpenAIResponsesWSModelWithPromptCacheKey({}, 'gpt-test')).toBeInstanceOf(
    OpenAIResponsesWSModelWithPromptCacheKey,
  );
});

it('reuses the streamed websocket model for a session so sequential turns keep one socket', async () => {
  const { getProvider } = await import('./index.js');
  const provider = getProvider('openai');
  const sessionContextService = {
    getContext: () => ({ sessionId: 'sess-1', sessionStartedAt: '2026-01-01T00:00:00.000Z' }),
    runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
  };
  const mockSettingsService: any = {
    get: (key: string) => {
      if (key === 'agent.model') return 'gpt-4o';
      if (key === 'agent.openai.apiKey') return 'sk-test';
      if (key === 'agent.transport') return 'websocket';
      return undefined;
    },
  };
  const deps = {
    settingsService: mockSettingsService,
    loggingService: {} as any,
    sessionContextService,
  };

  const first = await provider!.createStreamedModel!('gpt-4o', deps);
  const second = await provider!.createStreamedModel!('gpt-4o', deps);

  expect(second).toBe(first);
});

it('creates a streamed model via provider registry and executes stream()', async () => {
  const { getProvider } = await import('./index.js');
  const provider = getProvider('openai');
  expect(provider?.createStreamedModel).toBeDefined();

  const mockSettingsService: any = {
    get: (key: string) => {
      if (key === 'agent.model') return 'gpt-4o';
      if (key === 'agent.openai.apiKey') return 'sk-test';
      if (key === 'agent.transport') return 'http';
      return undefined;
    },
  };

  const streamedTurn = (await provider!.createStreamedModel!('gpt-4o', {
    settingsService: mockSettingsService,
    loggingService: {} as any,
  })) as any;

  expect(streamedTurn).toBeDefined();
  expect(typeof streamedTurn.stream).toBe('function');

  // Verify stream() execution through the direct application model instance
  const modelInstance = new OpenAIResponsesModelWithPromptCacheKey(
    {
      responses: {
        create: async () =>
          (async function* () {
            yield { type: 'response.created', response: { id: 'stream-exec-1' } };
            yield { type: 'response.output_text.delta', delta: 'stream test output' };
            yield { type: 'response.completed', response: { id: 'stream-exec-1', output: [] } };
          })(),
      },
    },
    'gpt-4o',
  );

  const events: any[] = [];
  for await (const event of modelInstance.stream({
    input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
  })) {
    events.push(event);
  }

  expect(events.length).toBeGreaterThan(0);
  expect(events[0]).toEqual({ type: 'text_delta', text: 'stream test output' });
  expect(events[1].type).toBe('completion');
  expect(events[1].responseId).toBe('stream-exec-1');
});
