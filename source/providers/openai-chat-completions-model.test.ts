import { it, expect } from 'vitest';
import { OpenAIChatCompletionsModel } from './openai-chat-completions-model.js';
import { ApplicationRunLoop } from '../services/agent-runtime/application-run-loop.js';

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
    codex: { promptCacheKey: 'must-not-leak', include: ['reasoning.encrypted_content'] },
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
  expect(capturedBody).not.toHaveProperty('prompt_cache_key');
  expect(capturedBody).not.toHaveProperty('include');
});

it('stream() maps application structured output to native response_format', async () => {
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
  const model = new OpenAIChatCompletionsModel(client, 'fixture-chat');
  for await (const _event of model.stream({
    input: [],
    tools: [],
    outputType: {
      type: 'json_schema',
      name: 'result',
      strict: true,
      schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  })) {
    // drain
  }
  expect(capturedBody.response_format).toEqual({
    type: 'json_schema',
    json_schema: {
      name: 'result',
      strict: true,
      schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  });
});

it('stream() carries terminal Chat usage into the completion and application run state', async () => {
  async function* usageStream(): AsyncIterable<any> {
    yield { choices: [{ delta: { content: 'done' } }] };
    yield {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    };
  }
  const client = { chat: { completions: { create: async () => usageStream() } } };
  const model = new OpenAIChatCompletionsModel(client, 'fixture-chat');
  const events: any[] = [];
  for await (const event of model.stream({ input: [], tools: [] } as any)) events.push(event);

  expect(events.find((event) => event.type === 'completion')).toMatchObject({
    usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 },
  });

  const loop = new ApplicationRunLoop({ resolveModel: () => model });
  const stream = loop.startStream(
    { name: 'usage-chat', instructions: '', model: 'fixture-chat', tools: [] } as any,
    'hello',
  );
  await stream.completed;
  expect(stream.runUsage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 40 });
});

it('stream() serializes Chat generation settings including zero values and named tool choice', async () => {
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
  const model = new OpenAIChatCompletionsModel(client, 'fixture-chat');

  for await (const _event of model.stream({
    input: [],
    tools: [],
    temperature: 0,
    topP: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    maxTokens: 0,
    toolChoice: { name: 'shell' },
  })) {
    // drain
  }

  expect(capturedBody).toMatchObject({
    temperature: 0,
    top_p: 0,
    frequency_penalty: 0,
    presence_penalty: 0,
    max_tokens: 0,
    tool_choice: { type: 'function', function: { name: 'shell' } },
  });
});

async function collectCompletionForFinishReason(finishReason: string, withToolCall = false): Promise<any> {
  async function* response(): AsyncIterable<any> {
    if (withToolCall) {
      yield {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_finish', function: { name: 'shell', arguments: '{}' } }] } },
        ],
      };
    } else {
      yield { choices: [{ delta: { content: 'partial or complete' } }] };
    }
    yield { choices: [{ delta: {}, finish_reason: finishReason }] };
  }
  const model = new OpenAIChatCompletionsModel(
    { chat: { completions: { create: async () => response() } } },
    'fixture-chat',
  );
  const events: any[] = [];
  for await (const event of model.stream({ input: [], tools: [] })) events.push(event);
  return events.find((event) => event.type === 'completion');
}

it('stream() preserves stop and tool_calls finish reasons on application completion', async () => {
  await expect(collectCompletionForFinishReason('stop')).resolves.toMatchObject({ finishReason: 'stop' });
  await expect(collectCompletionForFinishReason('tool_calls', true)).resolves.toMatchObject({
    finishReason: 'tool_calls',
    output: [{ type: 'tool_call', id: 'call_finish' }],
  });
});

it('stream() preserves length and content_filter without imposing a UI error policy', async () => {
  await expect(collectCompletionForFinishReason('length')).resolves.toMatchObject({ finishReason: 'length' });
  await expect(collectCompletionForFinishReason('content_filter')).resolves.toMatchObject({
    finishReason: 'content_filter',
  });
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

it('application tool continuation replays native reasoning_content beside the prior assistant tool call', async () => {
  const bodies: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: any) => {
          bodies.push(body);
          if (bodies.length === 1) {
            return (async function* () {
              yield { choices: [{ delta: { reasoning_content: 'Need the fixture tool.' } }] };
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [{ index: 0, id: 'call_fixture', function: { name: 'lookup', arguments: '{}' } }],
                    },
                  },
                ],
              };
              yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
            })();
          }
          return (async function* () {
            yield { choices: [{ delta: { content: 'done' } }] };
            yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
          })();
        },
      },
    },
  };
  const model = new OpenAIChatCompletionsModel(client, 'console-go-thinking');
  const loop = new ApplicationRunLoop({ resolveModel: () => model });
  const stream = loop.startStream(
    {
      name: 'reasoning-continuation',
      instructions: 'Use tools when needed.',
      model: 'console-go-thinking',
      tools: [
        {
          name: 'lookup',
          parameters: { type: 'object' },
          needsApproval: async () => false,
          execute: async () => 'fixture result',
        },
      ] as any,
    },
    'look this up',
  );

  await stream.completed;

  expect(bodies).toHaveLength(2);
  expect(bodies[1].messages).toContainEqual({
    role: 'assistant',
    content: null,
    reasoning_content: 'Need the fixture tool.',
    tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
  });
});

it('application tool continuation keeps one reasoning-bearing assistant message for parallel tool calls', async () => {
  const bodies: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: any) => {
          bodies.push(body);
          if (bodies.length === 1) {
            return (async function* () {
              yield { choices: [{ delta: { reasoning_content: 'Need both fixture tools.' } }] };
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        { index: 0, id: 'call_first', function: { name: 'first', arguments: '{}' } },
                        { index: 1, id: 'call_second', function: { name: 'second', arguments: '{}' } },
                      ],
                    },
                  },
                ],
              };
              yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
            })();
          }
          return (async function* () {
            yield { choices: [{ delta: { content: 'done' } }] };
            yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
          })();
        },
      },
    },
  };
  const model = new OpenAIChatCompletionsModel(client, 'console-go-thinking');
  const loop = new ApplicationRunLoop({ resolveModel: () => model });
  const stream = loop.startStream(
    {
      name: 'parallel-reasoning-continuation',
      instructions: 'Use tools when needed.',
      model: 'console-go-thinking',
      tools: [
        { name: 'first', parameters: { type: 'object' }, needsApproval: async () => false, execute: async () => 'one' },
        {
          name: 'second',
          parameters: { type: 'object' },
          needsApproval: async () => false,
          execute: async () => 'two',
        },
      ] as any,
    },
    'look up both',
  );

  await stream.completed;

  const assistantMessages = bodies[1].messages.filter((message: any) => message.role === 'assistant');
  expect(assistantMessages).toEqual([
    {
      role: 'assistant',
      content: null,
      reasoning_content: 'Need both fixture tools.',
      tool_calls: [
        { id: 'call_first', type: 'function', function: { name: 'first', arguments: '{}' } },
        { id: 'call_second', type: 'function', function: { name: 'second', arguments: '{}' } },
      ],
    },
  ]);
});

it('second-turn replay coalesces native reasoning with its assistant text instead of sending an invalid reasoning-only message', async () => {
  let capturedRequest: any;
  async function* response(): AsyncIterable<any> {
    yield { choices: [{ delta: { content: 'next' }, finish_reason: 'stop' }] };
  }
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          capturedRequest = request;
          return response();
        },
      },
    },
  };
  const model = new OpenAIChatCompletionsModel(client, 'deepseek-v4-flash');

  for await (const _event of model.stream({
    input: [
      {
        type: 'reasoning',
        text: 'Prior reasoning.',
        providerMetadata: {
          reasoning_content: 'Prior reasoning.',
          openai_compatible_reasoning_content: true,
        },
      },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Prior answer.' }] },
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'Follow-up.' }] },
    ],
    tools: [],
  } as any)) {
    // Consume the stream so the request conversion and completion path both run.
  }

  expect(capturedRequest.messages).toEqual([
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Prior answer.' }],
      reasoning_content: 'Prior reasoning.',
    },
    { role: 'user', content: [{ type: 'text', text: 'Follow-up.' }] },
  ]);
  expect(
    capturedRequest.messages.some(
      (message: any) => message.role === 'assistant' && message.content == null && !message.tool_calls,
    ),
  ).toBe(false);
});

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
    {
      type: 'reasoning',
      text: 'Thinking it through.',
      providerMetadata: {
        reasoning_content: 'Thinking it through.',
        openai_compatible_reasoning_content: true,
      },
    },
    { type: 'message', content: [{ type: 'text', text: 'Final answer.' }] },
  ]);
});
