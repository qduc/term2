import { it, expect, vi } from 'vitest';

// The real ResponsesWS opens an actual WebSocket in its constructor. Mock the
// module so the websocket-transport tests below can drive `.stream()` without
// touching the network; each test overrides `fakeResponsesWSStream` first.
let fakeResponsesWSStream: () => AsyncIterable<any> = async function* () {};
vi.mock('openai/resources/responses/ws', () => ({
  ResponsesWS: class {
    send() {}
    close() {}
    stream() {
      return fakeResponsesWSStream();
    }
  },
}));

const { OpenAIResponsesModelWithPromptCacheKey, OpenAIResponsesWSModelWithPromptCacheKey, normalizeResponseEvent } =
  await import('./openai-responses-model.js');

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

it('normalizes only completed Responses events as successful completions', () => {
  expect(normalizeResponseEvent({ type: 'response.completed', response: { id: 'done' } })).toEqual({
    type: 'response_done',
    response: { id: 'done' },
  });
  expect(() =>
    normalizeResponseEvent({
      type: 'response.failed',
      response: { id: 'bad', status: 'failed', error: { message: 'quota' } },
    }),
  ).toThrow('response.failed (quota)');
  expect(() =>
    normalizeResponseEvent({ type: 'response.incomplete', response: { id: 'partial', status: 'incomplete' } }),
  ).toThrow('response.incomplete (incomplete)');
});

// bridgeBackToTurn (agents-model-bridge.ts) passes StreamedModelTurnInput items
// straight through using the app-internal generic shapes (`{type:'text'}`
// content parts, `{type:'tool_call', ...}`), not the Responses API's own item
// types. Without translation, the real API rejects every request with a 400 —
// this is what actually made the openai provider fail on every turn.
it('getResponse (HTTP) translates generic message content into input_text/output_text by role', async () => {
  let capturedBody: any;
  const client = {
    responses: {
      create: async (body: any) => {
        capturedBody = body;
        return { id: 'resp_1', output: [], usage: {} };
      },
    },
  };

  const model = new OpenAIResponsesModelWithPromptCacheKey(client, 'gpt-5.4-nano');
  await model.getResponse({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hello there' }] },
    ],
  });

  expect(capturedBody.input).toEqual([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello there' }] },
  ]);
});

it('getResponse (HTTP) translates tool_call and function_call_result items into function_call/function_call_output', async () => {
  let capturedBody: any;
  const client = {
    responses: {
      create: async (body: any) => {
        capturedBody = body;
        return { id: 'resp_1', output: [], usage: {} };
      },
    },
  };

  const model = new OpenAIResponsesModelWithPromptCacheKey(client, 'gpt-5.4-nano');
  await model.getResponse({
    input: [
      { type: 'tool_call', id: 'call_1', name: 'shell', arguments: '{"command":"ls"}' },
      // bridgeBackToTurn renames tool_result -> function_call_result with a
      // camelCase `callId` and an `{ text }`-wrapped output before this layer
      // ever sees it.
      { type: 'function_call_result', callId: 'call_1', output: { text: 'file1\nfile2' } },
    ],
  });

  expect(capturedBody.input).toEqual([
    { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":"ls"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'file1\nfile2' },
  ]);
});

it('getStreamedResponse (websocket) throws on an error frame instead of silently ending the stream', async () => {
  fakeResponsesWSStream = async function* () {
    yield { type: 'error', error: new Error('upstream rejected the request') };
  };
  const client = { responses: { create: async () => ({}) } };

  const model = new OpenAIResponsesWSModelWithPromptCacheKey(client, 'gpt-5.4-nano');
  await expect(collect(model.getStreamedResponse({ input: [] }))).rejects.toThrow('upstream rejected the request');
});

it('getStreamedResponse (websocket) throws on a close frame instead of silently ending the stream', async () => {
  fakeResponsesWSStream = async function* () {
    yield { type: 'close' };
  };
  const client = { responses: { create: async () => ({}) } };

  const model = new OpenAIResponsesWSModelWithPromptCacheKey(client, 'gpt-5.4-nano');
  await expect(collect(model.getStreamedResponse({ input: [] }))).rejects.toThrow(
    'closed before a terminal response event',
  );
});

it('stops consuming the websocket after a terminal response event', async () => {
  fakeResponsesWSStream = async function* () {
    yield { type: 'message', message: { type: 'response.completed', response: { id: 'resp_1' } } };
    await new Promise<void>(() => {});
  };
  const client = { responses: { create: async () => ({}) } };
  const model = new OpenAIResponsesWSModelWithPromptCacheKey(client, 'gpt-5.4-nano');
  const result = await Promise.race([
    collect(model.getStreamedResponse({ input: [] })),
    new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
  ]);

  expect(result).not.toBe('timed-out');
});
