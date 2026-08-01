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
