import { it, expect } from 'vitest';
import { OpenAIChatCompletionsModel } from './openai-chat-completions-model.js';
import { ApplicationRunLoop } from '../services/agent-runtime/application-run-loop.js';

async function* emptyStream(): AsyncIterable<any> {
  yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
}

async function* incompleteTextStream(): AsyncIterable<any> {
  yield { choices: [{ delta: { role: 'assistant', content: 'partial' } }] };
}

it('Chat model exposes only the application-owned streamed-turn contract', () => {
  const model = new OpenAIChatCompletionsModel({} as any, 'fixture-chat');

  expect(model).not.toHaveProperty('getResponse');
  expect(model).not.toHaveProperty('getStreamedResponse');
  expect(model).not.toHaveProperty('getModel');
});

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

it('stream() sends non-empty instructions as the leading system message before input history', async () => {
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

  for await (const _event of model.stream({
    instructions: 'Delegate independent work to workers.',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'Implement the plan.' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'I will inspect it.' }] },
    ],
    tools: [],
  } as any)) {
    // drain
  }

  expect(capturedBody.messages).toEqual([
    { role: 'system', content: 'Delegate independent work to workers.' },
    { role: 'user', content: [{ type: 'text', text: 'Implement the plan.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'I will inspect it.' }] },
  ]);
});

it('stream() omits the system message when instructions are empty', async () => {
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

  for await (const _event of model.stream({ instructions: '', input: [], tools: [] } as any)) {
    // drain
  }

  expect(capturedBody.messages).toEqual([]);
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

  expect(events.filter((event) => event.type === 'tool_call_streaming_delta')).toEqual([
    { type: 'tool_call_streaming_delta', toolName: 'shell', argumentCharCount: 11 },
    { type: 'tool_call_streaming_delta', toolName: 'shell', argumentCharCount: 20 },
  ]);

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
// `delta.reasoning_content` field alongside `delta.content`.
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

it('stream() surfaces reasoning_content as reasoning_delta events and in completion provider_opaque output', async () => {
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
    },
    {
      type: 'provider_opaque',
      provider: 'openai-compatible',
      item: {
        reasoning_content: 'Thinking it through.',
      },
    },
    { type: 'message', content: [{ type: 'text', text: 'Final answer.' }] },
  ]);
});

async function* openRouterReasoningStream(): AsyncIterable<any> {
  yield {
    choices: [
      {
        delta: {
          reasoning: 'Weighing',
          reasoning_details: [{ type: 'reasoning.text', text: 'Weighing', format: 'unknown', index: 0 }],
        },
      },
    ],
  };
  yield {
    choices: [
      {
        delta: {
          reasoning: ' the options.',
          reasoning_details: [{ type: 'reasoning.text', text: ' the options.', format: 'unknown', index: 0 }],
        },
      },
    ],
  };
  yield { choices: [{ delta: { content: 'Final answer.' } }] };
  yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
}

it('stream() surfaces OpenRouter-style delta.reasoning and reasoning_details in provider_opaque output', async () => {
  const client = {
    chat: { completions: { create: async () => openRouterReasoningStream() } },
  };

  const model = new OpenAIChatCompletionsModel(client, 'mimo-v2.5-pro');
  const events: any[] = [];
  for await (const event of model.stream({ input: [], tools: [] } as any)) {
    events.push(event);
  }

  const reasoningDeltas = events.filter((event) => event.type === 'reasoning_delta').map((event) => event.text);
  expect(reasoningDeltas).toEqual(['Weighing', ' the options.']);

  const completion = events.find((event) => event.type === 'completion');
  expect(completion.output).toEqual([
    {
      type: 'reasoning',
      text: 'Weighing the options.',
    },
    {
      type: 'provider_opaque',
      provider: 'openai-compatible',
      item: {
        reasoning: 'Weighing the options.',
        // One logical entry streamed over two chunks, not two entries: `index`
        // identifies the entry, so the chunks merge rather than accumulating as
        // fragments the provider never sent.
        reasoning_details: [{ type: 'reasoning.text', text: 'Weighing the options.', format: 'unknown', index: 0 }],
      },
    },
    { type: 'message', content: [{ type: 'text', text: 'Final answer.' }] },
  ]);
});

it('replays reasoning captured from delta.reasoning verbatim as reasoning and reasoning_details on continuation', async () => {
  const bodies: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: any) => {
          bodies.push(body);
          if (bodies.length === 1) {
            return (async function* () {
              yield {
                choices: [
                  {
                    delta: {
                      reasoning: 'Need the fixture tool.',
                      reasoning_details: [
                        { type: 'reasoning.text', text: 'Need the fixture tool.', format: 'unknown', index: 0 },
                      ],
                    },
                  },
                ],
              };
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
  const model = new OpenAIChatCompletionsModel(client, 'mimo-v2.5-pro');
  const loop = new ApplicationRunLoop({ resolveModel: () => model });
  const stream = loop.startStream(
    {
      name: 'openrouter-reasoning-continuation',
      instructions: 'Use tools when needed.',
      model: 'mimo-v2.5-pro',
      tools: [
        {
          name: 'lookup',
          parameters: { type: 'object' },
          needsApproval: async () => false,
          execute: async () => 'fixture result',
        },
      ] as any,
    },
    'Look it up.',
  );
  for await (const _event of stream) {
    // drain
  }

  console.log(JSON.stringify(bodies[1].messages, null, 2));
  expect(bodies).toHaveLength(2);
  const assistant = bodies[1].messages.find((message: any) => Array.isArray(message.tool_calls));
  expect(assistant.reasoning).toBe('Need the fixture tool.');
  expect(assistant.reasoning_details).toEqual([
    { type: 'reasoning.text', text: 'Need the fixture tool.', format: 'unknown', index: 0 },
  ]);
});

// A continuity payload from another provider is the ordinary residue of a
// provider switch. Refusing it used to kill every later turn as well, because
// nothing removes the item from history — the conversation became unusable
// rather than merely lossy.
it('drops provider_opaque from another provider and still sends the rest of the request', async () => {
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
  const model = new OpenAIChatCompletionsModel(client, 'fixture-chat', undefined, 'openrouter');
  const request = {
    input: [
      {
        type: 'provider_opaque',
        provider: 'deepseek',
        item: { reasoning_content: 'foreign thinking' },
      },
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ],
    tools: [],
  } as any;

  for await (const _event of model.stream(request)) {
    // drain
  }

  expect(JSON.stringify(capturedBody.messages)).not.toContain('foreign thinking');
  expect(capturedBody.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
});

// Two providers of type `openai-compatible` — a deepseek endpoint and an
// OpenRouter gateway — spell reasoning differently, so tagging opaque items with
// the shared type rather than the configured provider let one endpoint's fields
// be replayed into the other's request. That splice is still prevented; the
// payload is dropped rather than replayed.
it('drops an opaque item from a different provider of the same openai-compatible type', async () => {
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
  const model = new OpenAIChatCompletionsModel(client, 'fixture-chat', undefined, 'my-openrouter');
  const request = {
    input: [
      { type: 'provider_opaque', provider: 'my-deepseek', item: { reasoning_content: 'deepseek thinking' } },
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ],
    tools: [],
  } as any;

  for await (const _event of model.stream(request)) {
    // drain
  }

  expect(JSON.stringify(capturedBody.messages)).not.toContain('deepseek thinking');
});

// A continuity payload is only known once the completion arrives, so the run
// loop appends the opaque item after the turn's tool results. Anchoring it on
// whichever message happened to be last attached it to a `tool` message's
// predecessor — a *previous* turn's assistant message — clobbering that turn's
// own reasoning with a later turn's.
it('splices a trailing opaque payload onto its own turn, not an earlier assistant message', async () => {
  const bodies: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: any) => {
          bodies.push(body);
          return emptyStream();
        },
      },
    },
  };
  const model = new OpenAIChatCompletionsModel(client, 'fixture-chat', undefined, 'gateway');
  const request = {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'first' }] },
      { type: 'tool_call', id: 'call_a', name: 'lookup', arguments: '{}' },
      { type: 'tool_result', id: 'call_a', output: 'a' },
      { type: 'provider_opaque', provider: 'gateway', item: { reasoning: 'first turn thinking' } },
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'second' }] },
      { type: 'tool_call', id: 'call_b', name: 'lookup', arguments: '{}' },
      { type: 'tool_result', id: 'call_b', output: 'b' },
      { type: 'provider_opaque', provider: 'gateway', item: { reasoning: 'second turn thinking' } },
    ],
    tools: [],
  } as any;

  for await (const _event of model.stream(request)) {
    // drain
  }

  const assistants = bodies[0].messages.filter((message: any) => message.role === 'assistant');
  expect(assistants).toHaveLength(2);
  expect(assistants[0].tool_calls[0].id).toBe('call_a');
  expect(assistants[0].reasoning).toBe('first turn thinking');
  expect(assistants[1].tool_calls[0].id).toBe('call_b');
  expect(assistants[1].reasoning).toBe('second turn thinking');
});

// The payload is the same reasoning the normalized item carries, in the
// provider's own spelling. Replaying both sends the tokens twice, in two fields.
it('replaces reconstructed reasoning_content with the payload spelling rather than sending both', async () => {
  const bodies: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: any) => {
          bodies.push(body);
          return emptyStream();
        },
      },
    },
  };
  const model = new OpenAIChatCompletionsModel(client, 'fixture-chat', undefined, 'gateway');
  const request = {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        type: 'reasoning',
        text: 'Thinking.',
        providerMetadata: { reasoning_content: 'Thinking.', openai_compatible_reasoning_content: true },
      },
      { type: 'tool_call', id: 'call_a', name: 'lookup', arguments: '{}' },
      { type: 'tool_result', id: 'call_a', output: 'a' },
      { type: 'provider_opaque', provider: 'gateway', item: { reasoning: 'Thinking.' } },
    ],
    tools: [],
  } as any;

  for await (const _event of model.stream(request)) {
    // drain
  }

  const assistant = bodies[0].messages.find((message: any) => Array.isArray(message.tool_calls));
  expect(assistant.reasoning).toBe('Thinking.');
  expect(assistant).not.toHaveProperty('reasoning_content');
});

it('preserves generic reasoning without native OpenAI metadata as an assistant text message', async () => {
  const client = {
    chat: {
      completions: {
        create: async (body: any) => {
          expect(body.messages).toContainEqual({ role: 'assistant', content: 'generic reasoning fallback' });
          return emptyStream();
        },
      },
    },
  };
  const model = new OpenAIChatCompletionsModel(client, 'fixture-chat');
  const request = {
    input: [
      {
        type: 'reasoning',
        text: 'generic reasoning fallback',
      },
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ],
    tools: [],
  } as any;

  for await (const _event of model.stream(request)) {
    // drain
  }
});

it('captures non-modeled delta properties such as refusal into rawContinuityMetadata', async () => {
  const client = {
    chat: {
      completions: {
        create: async () => {
          return (async function* () {
            yield { choices: [{ delta: { refusal: 'I cannot answer.' } }] };
            yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
          })();
        },
      },
    },
  };
  const model = new OpenAIChatCompletionsModel(client, 'fixture-chat');
  const events: any[] = [];
  for await (const event of model.stream({ input: [], tools: [] } as any)) {
    events.push(event);
  }
  const completion = events.find((e) => e.type === 'completion');
  expect(completion.output).toContainEqual({
    type: 'provider_opaque',
    provider: 'openai-compatible',
    item: { refusal: 'I cannot answer.' },
  });
});

it('attaches a captured provider cost trailer as costUsd on the completion', async () => {
  const client = {
    chat: {
      completions: {
        create: async (_body: any) => emptyStream(),
      },
    },
  };
  const costCapture: { cost?: string } = { cost: '0.00002772' };
  const model = new OpenAIChatCompletionsModel(client, 'fixture-chat', costCapture as any);

  let completionCostUsd: unknown;
  for await (const event of model.stream({ input: [], tools: [] } as any)) {
    if (event.type === 'completion') completionCostUsd = (event as any).costUsd;
  }
  expect(completionCostUsd).toBe('0.00002772');
});

it('omits costUsd when no provider cost trailer was captured', async () => {
  const client = {
    chat: {
      completions: {
        create: async (_body: any) => emptyStream(),
      },
    },
  };
  const model = new OpenAIChatCompletionsModel(client, 'fixture-chat');

  let sawCompletion = false;
  for await (const event of model.stream({ input: [], tools: [] } as any)) {
    if (event.type === 'completion') {
      sawCompletion = true;
      expect(event).not.toHaveProperty('costUsd');
    }
  }
  expect(sawCompletion).toBe(true);
});

// A chat-completions response may carry assistant prose *and* tool calls in the
// same choice. Dropping the prose from the completion output erased it from
// history: every later request replayed the turn as a bare `content: null` tool
// call, so the model never saw what it had told the user.
it('stream() keeps assistant text that arrived alongside tool calls', async () => {
  async function* textWithToolCallStream(): AsyncIterable<any> {
    yield { choices: [{ delta: { content: "I'll check the logs." } }] };
    yield {
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: 'shell', arguments: '{}' } }] } }],
    };
    yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
  }

  const client = { chat: { completions: { create: async () => textWithToolCallStream() } } };
  const model = new OpenAIChatCompletionsModel(client, 'fixture-chat');
  const events: any[] = [];
  for await (const event of model.stream({ input: [], tools: [] } as any)) {
    events.push(event);
  }

  const completion = events.find((event) => event.type === 'completion');
  expect(completion.output).toEqual([
    { type: 'message', content: [{ type: 'text', text: "I'll check the logs." }] },
    { type: 'tool_call', id: 'call_x', name: 'shell', arguments: '{}' },
  ]);
});

// One turn must stay one assistant message: `attachOpaquePayloads` pairs the
// i-th continuity payload with the i-th assistant message, so splitting a turn
// into a text message plus a tool-call message would hand each turn's reasoning
// to the wrong half.
it('replays assistant text and its turn tool calls as one assistant message', async () => {
  const bodies: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: any) => {
          bodies.push(body);
          return emptyStream();
        },
      },
    },
  };
  const model = new OpenAIChatCompletionsModel(client, 'fixture-chat', undefined, 'gateway');
  const request = {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'first' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: "I'll check the logs." }] },
      { type: 'tool_call', id: 'call_a', name: 'lookup', arguments: '{}' },
      { type: 'tool_result', id: 'call_a', output: 'a' },
      { type: 'provider_opaque', provider: 'gateway', item: { reasoning: 'first turn thinking' } },
    ],
    tools: [],
  } as any;

  for await (const _event of model.stream(request)) {
    // drain
  }

  const assistants = bodies[0].messages.filter((message: any) => message.role === 'assistant');
  expect(assistants).toHaveLength(1);
  expect(assistants[0].content).toEqual([{ type: 'text', text: "I'll check the logs." }]);
  expect(assistants[0].tool_calls[0].id).toBe('call_a');
  expect(assistants[0].reasoning).toBe('first turn thinking');
});

// A new user message ends the turn, so tool calls after it belong to a later
// assistant message and must not be folded back onto the earlier prose.
it('does not attach later-turn tool calls to an assistant message from an earlier turn', async () => {
  const bodies: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: any) => {
          bodies.push(body);
          return emptyStream();
        },
      },
    },
  };
  const model = new OpenAIChatCompletionsModel(client, 'fixture-chat', undefined, 'gateway');
  const request = {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'first' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'second' }] },
      { type: 'tool_call', id: 'call_b', name: 'lookup', arguments: '{}' },
      { type: 'tool_result', id: 'call_b', output: 'b' },
    ],
    tools: [],
  } as any;

  for await (const _event of model.stream(request)) {
    // drain
  }

  const assistants = bodies[0].messages.filter((message: any) => message.role === 'assistant');
  expect(assistants).toHaveLength(2);
  expect(assistants[0].tool_calls).toBeUndefined();
  expect(assistants[1].tool_calls[0].id).toBe('call_b');
});

// Streaming chat completions omit the usage block unless the request opts in.
// Without it `lastUsage` stayed empty for every chat-completions provider, so
// the status bar could never show context, token counts, or cost.
it('requests streamed usage so the status bar has token counts', async () => {
  const bodies: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: any) => {
          bodies.push(body);
          return emptyStream();
        },
      },
    },
  };
  const model = new OpenAIChatCompletionsModel(client, 'fixture-chat');

  for await (const _event of model.stream({ input: [], tools: [] } as any)) {
    // drain
  }

  expect(bodies[0].stream_options).toEqual({ include_usage: true });
});

// The opt-in terminal chunk carries usage with an empty `choices` array.
it('reports usage from the terminal chunk that carries no choice', async () => {
  async function* usageTerminalStream(): AsyncIterable<any> {
    yield { choices: [{ delta: { content: 'done' } }] };
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    yield { choices: [], usage: { prompt_tokens: 1234, completion_tokens: 56 } };
  }

  const client = { chat: { completions: { create: async () => usageTerminalStream() } } };
  const model = new OpenAIChatCompletionsModel(client, 'fixture-chat');
  const events: any[] = [];
  for await (const event of model.stream({ input: [], tools: [] } as any)) {
    events.push(event);
  }

  const completion = events.find((event) => event.type === 'completion');
  expect(completion.usage).toMatchObject({ inputTokens: 1234, outputTokens: 56 });
});
