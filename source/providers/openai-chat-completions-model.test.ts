import { it, expect } from 'vitest';
import { OpenAIChatCompletionsModel } from './openai-chat-completions-model.js';

async function* emptyStream(): AsyncIterable<any> {
  yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
}

async function* incompleteTextStream(): AsyncIterable<any> {
  yield { choices: [{ delta: { role: 'assistant', content: 'partial' } }] };
}

it('stream() sends message content as OpenAI-compatible content parts, not raw strings', async () => {
  let capturedBody: any;
  const client = {
    chat: {
      completions: {
        create: async (body: any) => {
          capturedBody = body;
          return emptyStream();
        },
      },
    },
  };

  const model = new OpenAIChatCompletionsModel(client, 'deepseek-v4-flash');
  const request = {
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'docs/plans/decouple-from-openai-agents-sdk.md check progress' }],
      },
    ],
    tools: [],
  } as any;

  for await (const _event of model.stream(request)) {
    // drain
  }

  expect(capturedBody.messages).toEqual([
    {
      role: 'user',
      content: [{ type: 'text', text: 'docs/plans/decouple-from-openai-agents-sdk.md check progress' }],
    },
  ]);
});

it('stream() rejects EOF before a finish_reason instead of synthesizing completion', async () => {
  const client = {
    chat: { completions: { create: async () => incompleteTextStream() } },
  };
  const model = new OpenAIChatCompletionsModel(client, 'fixture-chat');

  await expect(
    (async () => {
      for await (const _event of model.stream({ input: [], tools: [] } as any)) {
        // drain
      }
    })(),
  ).rejects.toThrow('without a finish reason');
});

// Real streaming servers send `id` and `function.name` only on the first SSE
// chunk for a tool call; every later chunk carries just
// `{ index, function: { arguments } }` with no `id`. Keying the accumulator by
// `id ?? index` used to split one tool call into two map entries once the
// id-less chunks fell through to the index key, leaving the id-keyed entry
// with an empty `arguments` string.
async function* chunkedToolCallStream(): AsyncIterable<any> {
  yield {
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'shell', arguments: '' } }] } }],
  };
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] } }] };
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls -la"}' } }] } }] };
  yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
}

it('stream() reassembles a tool call whose arguments span multiple id-less SSE chunks', async () => {
  const client = {
    chat: { completions: { create: async () => chunkedToolCallStream() } },
  };

  const model = new OpenAIChatCompletionsModel(client, 'deepseek-v4-flash');
  const events: any[] = [];
  for await (const event of model.stream({ input: [], tools: [] } as any)) {
    events.push(event);
  }

  const toolCallEvent = events.find((event) => event.type === 'tool_call');
  expect(toolCallEvent).toEqual({
    type: 'tool_call',
    id: 'call_abc',
    name: 'shell',
    arguments: '{"command":"ls -la"}',
  });

  const completion = events.find((event) => event.type === 'completion');
  expect(completion.output).toEqual([
    { type: 'tool_call', id: 'call_abc', name: 'shell', arguments: '{"command":"ls -la"}' },
  ]);
});

it('getStreamedResponse() (legacy path) reassembles a tool call whose arguments span multiple id-less SSE chunks', async () => {
  const client = {
    chat: { completions: { create: async () => chunkedToolCallStream() } },
  };

  const model = new OpenAIChatCompletionsModel(client, 'deepseek-v4-flash');
  const events: any[] = [];
  for await (const event of model.getStreamedResponse({ input: [], modelSettings: {} } as any)) {
    events.push(event);
  }

  const done = events.find((event) => event.type === 'response_done');
  expect(done.response.output).toEqual([
    { type: 'function_call', callId: 'call_abc', name: 'shell', arguments: '{"command":"ls -la"}' },
  ]);
});

// createCustomProviderModelProvider() (openai-compatible.provider.ts) returns this
// class directly for the 'openai'/'openai-compatible'/'llama.cpp' provider types, and
// every caller (openai-compatible.provider.ts and openai-compatible-lazy.ts) requires
// a getStreamedModel() method, throwing "has no application-owned streamed model" if
// it's absent — which broke every provider on this transport (deepseek, grok,
// lmstudio, llamacpp, generic openai-compatible baseUrl entries) via the real CLI path.
it('exposes getStreamedModel() so custom-provider wiring does not reject this class', () => {
  const model = new OpenAIChatCompletionsModel({} as any, 'deepseek-v4-flash');
  expect(typeof (model as any).getStreamedModel).toBe('function');
  expect((model as any).getStreamedModel()).toBe(model);
});

// Real servers (e.g. deepseek-reasoner) stream reasoning content as a separate
// `delta.reasoning_content` field alongside `delta.content`. The modern stream()
// path (used whenever request.modelSettings is absent, which is how
// application-run-loop.ts calls it) only read `delta.content`, silently dropping
// all reasoning content — no reasoning_delta event, no reasoning in the final output.
async function* reasoningStream(): AsyncIterable<any> {
  yield { choices: [{ delta: { reasoning_content: 'Thinking' } }] };
  yield { choices: [{ delta: { reasoning_content: ' it through.' } }] };
  yield { choices: [{ delta: { content: 'Final answer.' } }] };
  yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
}

it('stream() surfaces reasoning_content as reasoning_delta events and in the completion output', async () => {
  const client = {
    chat: { completions: { create: async () => reasoningStream() } },
  };

  const model = new OpenAIChatCompletionsModel(client, 'deepseek-reasoner');
  const events: any[] = [];
  for await (const event of model.stream({ input: [], tools: [] } as any)) {
    events.push(event);
  }

  const reasoningDeltas = events.filter((event) => event.type === 'reasoning_delta').map((event) => event.text);
  expect(reasoningDeltas).toEqual(['Thinking', ' it through.']);

  const completion = events.find((event) => event.type === 'completion');
  expect(completion.output).toEqual([
    { type: 'reasoning', text: 'Thinking it through.' },
    { type: 'message', content: [{ type: 'text', text: 'Final answer.' }] },
  ]);
});
