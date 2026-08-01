import { expect, it } from 'vitest';
import { OpenAIResponsesModelWithPromptCacheKey, OpenAIResponsesWSModelWithPromptCacheKey } from './openai.provider.js';

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
    input: 'hello',
    tools: [],
    modelSettings: { providerData: { extraBody: { prompt_cache_key: 's1' } } },
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
  for await (const event of model.getStreamedResponse({ input: 'hello', tools: [], modelSettings: {} }))
    events.push(event);
  expect(events.map((event) => event.type)).toEqual(['response_started', 'output_text_delta', 'response_done']);
  expect(events[1].delta).toBe('hello');
});

it('retains a separate public transport class for WebSocket-configured sessions', () => {
  expect(new OpenAIResponsesWSModelWithPromptCacheKey({}, 'gpt-test')).toBeInstanceOf(
    OpenAIResponsesWSModelWithPromptCacheKey,
  );
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

  // Verify stream() execution through an adapted model instance
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

  const { bridgeBackToTurn } = await import('./agents-model-bridge.js');
  const adaptedTurn = bridgeBackToTurn(modelInstance);

  const events: any[] = [];
  for await (const event of adaptedTurn.stream({
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
