import { it, expect, vi } from 'vitest';
const withTrace = async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();
import {
  CodexResponsesTransport,
  OpenAIResponsesModel,
  CodexResponsesModel,
  CodexResponsesWSModel,
} from './codex-responses-model.js';
import type { IProviderTraffic } from '../services/service-interfaces.js';
import { SessionContextService } from '../services/session/session-context-service.js';
import { wrapCodexStream } from './codex-responses-model.js';
import { RetryingModel } from './retrying-model.js';
import { AmbiguousModelOutcomeError } from '../services/retry/retry-errors.js';
// Fixture mirrors the SSE shape that codex's responses endpoint emits: deltas
// and output_item.done carry the assistant message, but the terminal
// response.completed frame ships an empty `output` array. The wrapper has to
// reconstruct the final output from the accumulated output_item.done items so
// the agents-SDK runner does not see "no output" and re-loop.
function makeStream(events: any[]) {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

it('uses isolated injected Codex transports without changing model prototypes', async () => {
  const baseFetch = Object.getOwnPropertyDescriptor(OpenAIResponsesModel.prototype, 'fetchResponse')?.value;
  const firstTransport = new CodexResponsesTransport();
  const secondTransport = new CodexResponsesTransport();
  firstTransport.fetchResponse = async () =>
    makeStream([{ type: 'response.completed', response: { id: 'response-first', output: [], usage: {} } }]);
  secondTransport.fetchResponse = async () =>
    makeStream([{ type: 'response.completed', response: { id: 'response-second', output: [], usage: {} } }]);

  const first = new CodexResponsesModel({} as any, 'gpt-test', undefined, undefined, firstTransport);
  const second = new CodexResponsesModel({} as any, 'gpt-test', undefined, undefined, secondTransport);
  const request = { input: [], tools: [] };

  const firstEvents = await collect(first.stream(request));
  const secondEvents = await collect(second.stream(request));

  expect(firstEvents.find((event: any) => event.type === 'completion')).toMatchObject({ responseId: 'response-first' });
  expect(secondEvents.find((event: any) => event.type === 'completion')).toMatchObject({
    responseId: 'response-second',
  });
  expect(Object.getOwnPropertyDescriptor(OpenAIResponsesModel.prototype, 'fetchResponse')?.value).toBe(baseFetch);
});

it('wrapCodexStream reconstructs response.completed.output from streamed output_item.done items', async () => {
  const item = {
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Hello!' }],
  };

  const events = await collect(
    wrapCodexStream(
      makeStream([
        { type: 'response.created', response: { id: 'resp_1' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.output_text.delta', delta: '!' },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          },
        },
      ]),
    ),
  );

  const completed = events.find((e: any) => e.type === 'response.completed') as any;
  expect(completed).toBeTruthy();
  expect(completed.response.output.length).toBe(1);
  expect(completed.response.output[0]).toBe(item);
});

it('wrapCodexStream reconstructs missing terminal response.output from streamed output_item.done items', async () => {
  const item = {
    type: 'message',
    id: 'msg_missing_output',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Recovered' }],
  };

  const events = await collect(
    wrapCodexStream(
      makeStream([
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: 'resp_missing_output',
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    ),
  );

  const completed = events.find((e: any) => e.type === 'response.completed') as any;
  expect(completed).toBeTruthy();
  expect(completed.response.output).toEqual([item]);
});

it('wrapCodexStream reconstructs missing output for non-completed terminal frames', async () => {
  const item = {
    type: 'message',
    id: 'msg_incomplete',
    role: 'assistant',
    status: 'incomplete',
    content: [{ type: 'output_text', text: 'Partial' }],
  };

  const events = await collect(
    wrapCodexStream(
      makeStream([
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.incomplete',
          response: {
            id: 'resp_incomplete',
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    ),
  );

  const incomplete = events.find((e: any) => e.type === 'response.incomplete') as any;
  expect(incomplete).toBeTruthy();
  expect(incomplete.response.output).toEqual([item]);
});

it('wrapCodexStream leaves non-empty output untouched', async () => {
  const serverItem = { type: 'message', id: 'msg_real' };
  const streamedItem = { type: 'message', id: 'msg_accum' };

  const events = await collect(
    wrapCodexStream(
      makeStream([
        { type: 'response.output_item.done', output_index: 0, item: streamedItem },
        {
          type: 'response.completed',
          response: { id: 'resp_2', output: [serverItem], usage: {} },
        },
      ]),
    ),
  );

  const completed = events.find((e: any) => e.type === 'response.completed') as any;
  expect(completed.response.output.length).toBe(1);
  expect(completed.response.output[0]).toBe(serverItem);
});

it('wrapCodexStream reconstructs each completed response from only its own streamed items', async () => {
  const firstItem = { type: 'function_call', id: 'fc_1', call_id: 'call_1' };
  const secondItem = { type: 'message', id: 'msg_2', role: 'assistant' };

  const events = await collect(
    wrapCodexStream(
      makeStream([
        { type: 'response.created', response: { id: 'resp_1' } },
        { type: 'response.output_item.done', output_index: 0, item: firstItem },
        { type: 'response.completed', response: { id: 'resp_1', output: [], usage: {} } },
        { type: 'response.created', response: { id: 'resp_2' } },
        { type: 'response.output_item.done', output_index: 0, item: secondItem },
        { type: 'response.completed', response: { id: 'resp_2', output: [], usage: {} } },
      ]),
    ),
  );

  const completed = events.filter((e: any) => e.type === 'response.completed') as any[];
  expect(completed.length).toBe(2);
  expect(completed[0].response.output).toEqual([firstItem]);
  expect(completed[1].response.output).toEqual([secondItem]);
});

it('wrapCodexStream keeps empty output empty when no items were streamed', async () => {
  const events = await collect(
    wrapCodexStream(
      makeStream([
        {
          type: 'response.completed',
          response: { id: 'resp_3', output: [], usage: {} },
        },
      ]),
    ),
  );
  const completed = events.find((e: any) => e.type === 'response.completed') as any;
  expect(completed.response.output.length).toBe(0);
});

it('wrapCodexStream backfills function_call call_id from function_call_arguments.done event', async () => {
  const expectedCallId = 'call_backfilled';

  // Simulate Codex sending function_call_arguments.done with the call_id
  // followed by output_item.done WITHOUT a call_id field.
  const item = {
    type: 'function_call',
    id: 'fc_backfill',
    name: 'shell',
    arguments: '{}',
    status: 'completed',
    // NO call_id — Codex sometimes omits it here
  };

  const events = await collect(
    wrapCodexStream(
      makeStream([
        {
          type: 'response.function_call_arguments.done',
          item_id: 'fc_backfill',
          call_id: expectedCallId,
          name: 'shell',
          arguments: '{}',
        },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: 'resp_backfill',
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    ),
  );

  const completed = events.find((e: any) => e.type === 'response.completed') as any;
  expect(completed).toBeTruthy();
  expect(completed.response.output.length).toBe(1);
  expect(completed.response.output[0].call_id).toBe(expectedCallId);
  expect(completed.response.output[0].id).toBe('fc_backfill');
});

it('wrapCodexStream survives a frozen response object by cloning', async () => {
  const item = { type: 'message', id: 'msg_frozen' };
  const frozenResponse = Object.freeze({ id: 'resp_f', output: [], usage: {} });

  const events = await collect(
    wrapCodexStream(
      makeStream([
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: frozenResponse },
      ]),
    ),
  );

  const completed = events.find((e: any) => e.type === 'response.completed') as any;
  expect(completed.response.output.length).toBe(1);
  expect(completed.response.output[0]).toBe(item);
});

it('wrapCodexStream warns with metadata when reconstructed output is suspiciously large', async () => {
  const warnings: any[] = [];
  const items = Array.from({ length: 21 }, (_, index) => ({
    type: index % 2 === 0 ? 'function_call' : 'function_call_output',
    id: `item_${index}`,
    call_id: `call_${Math.floor(index / 2)}`,
    output: `hidden-output-${index}`,
  }));

  const events = await collect(
    wrapCodexStream(
      makeStream([
        ...items.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })),
        { type: 'response.completed', response: { id: 'resp_large', output: [], usage: {} } },
      ]),
      { warn: (_message: string, meta?: any) => warnings.push(meta) },
    ),
  );

  const completed = events.find((e: any) => e.type === 'response.completed') as any;
  expect(completed.response.output.length).toBe(21);
  expect(warnings.length).toBe(1);
  expect(warnings[0].eventType).toBe('codex.reconstructed_output.suspicious');
  expect(warnings[0].responseId).toBe('resp_large');
  expect(warnings[0].itemCount).toBe(21);
  expect(warnings[0].firstItemId).toBe('item_0');
  expect(warnings[0].lastItemId).toBe('item_20');
  expect('output' in warnings[0]).toBe(false);
});

// Integration check: confirm CodexResponsesModel.stream threads
// the stream through wrapCodexStream so a Codex-style terminal frame with
// empty output gets rebuilt into a populated completion event. The owned
// transport dependency supplies a controlled stream without a real client.
it('CodexResponsesModel.stream yields completion with reconstructed output', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.created', response: { id: 'resp_1' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hello!' }],
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          output: [],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      },
    ]);
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const request: any = { input: [], tools: [] };
    const events = await collect(model.stream(request));

    const done = events.find((e: any) => e.type === 'completion') as any;
    expect(done).toBeTruthy();
    expect(done.output.length).toBe(1);
    expect(done.output[0].type).toBe('message');
  } finally {
  }
});

it('CodexResponsesModel.stream tolerates missing terminal response.output', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.created', response: { id: 'resp_missing_output' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_missing_output',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Recovered' }],
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_missing_output',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ]);
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const request: any = { input: [], tools: [] };
    const events = await collect(model.stream(request));

    const done = events.find((e: any) => e.type === 'completion') as any;
    expect(done).toBeTruthy();
    expect(done.output.length).toBe(1);
  } finally {
  }
});

it('CodexResponsesModel.buildResponsesCreateRequest merges Codex include into requestData.include', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        include: ['file_search_call.results'],
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const built = (model as any).buildResponsesCreateRequest(
      {
        input: [],
        tools: [],
        codex: { include: ['reasoning.encrypted_content', 'file_search_call.results'] },
      },
      true,
    );

    expect(built.requestData.include).toEqual(['file_search_call.results', 'reasoning.encrypted_content']);
  } finally {
  }
});

it('CodexResponsesTransport formats reasoning input items with required summary array for Responses API', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5.6-sol', false);
  const built = transport.buildResponsesCreateRequest(
    {
      input: [
        {
          type: 'reasoning',
          id: 'rs_1',
          text: 'thinking process',
          providerMetadata: { codex: { encrypted_content: 'cipher_a' } },
        },
        {
          type: 'reasoning',
          id: 'rs_2',
          text: '',
          providerMetadata: { codex: { encrypted_content: 'cipher_b' } },
        },
      ],
      tools: [],
    },
    true,
  );

  expect(built.requestData.input).toEqual([
    {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'thinking process' }],
      encrypted_content: 'cipher_a',
    },
    {
      type: 'reasoning',
      id: 'rs_2',
      summary: [],
      encrypted_content: 'cipher_b',
    },
  ]);
});

it('Codex HTTP writes every supported request setting and the abort signal to the Responses boundary', async () => {
  let capturedBody: any;
  let capturedOptions: any;
  const client = {
    responses: {
      create: async (body: any, options: any) => {
        capturedBody = body;
        capturedOptions = options;
        return makeStream([{ type: 'response.completed', response: { id: 'resp_settings', output: [], usage: {} } }]);
      },
    },
  };
  const controller = new AbortController();
  const model = new CodexResponsesModel(client as any, 'gpt-5.3-codex');
  await collect(
    model.stream({
      instructions: 'PROJECT_CONTEXT_SENTINEL',
      previousResponseId: 'resp_before',
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'lookup', parameters: { type: 'object' } }],
      signal: controller.signal,
      toolChoice: { name: 'lookup' },
      temperature: 0.2,
      topP: 0.8,
      frequencyPenalty: 0.3,
      presencePenalty: 0.4,
      maxTokens: 123,
      reasoning: { effort: 'high', summary: 'concise' },
      providerOptions: { generate: false, custom_codex_option: true, extraHeaders: { 'x-test': 'yes' } },
    }),
  );

  expect(capturedBody).toMatchObject({
    model: 'gpt-5.3-codex',
    stream: true,
    instructions: 'PROJECT_CONTEXT_SENTINEL',
    previous_response_id: 'resp_before',
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    tool_choice: { type: 'function', name: 'lookup' },
    top_p: 0.8,
    frequency_penalty: 0.3,
    presence_penalty: 0.4,
    reasoning: { effort: 'high', summary: 'concise' },
    generate: false,
    custom_codex_option: true,
  });
  expect(capturedBody.temperature).toBeUndefined();
  expect(capturedBody.max_output_tokens).toBeUndefined();
  expect(capturedOptions).toEqual({ signal: controller.signal, headers: { 'x-test': 'yes' } });
});

it('CodexResponsesModel.buildResponsesCreateRequest strips temperature and max_output_tokens from requestData', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        temperature: 0.2,
        max_output_tokens: 16384,
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const built = (model as any).buildResponsesCreateRequest(
      { input: [], tools: [], temperature: 0.2, maxTokens: 16384 },
      true,
    );

    expect('temperature' in built.requestData).toBe(false);
    expect('max_output_tokens' in built.requestData).toBe(false);
  } finally {
  }
});

it('CodexResponsesModel.buildResponsesCreateRequest forwards the Codex prompt cache key', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        include: [],
        temperature: 0.4,
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const built = (model as any).buildResponsesCreateRequest(
      { input: [], tools: [], codex: { promptCacheKey: 'conv_123' } },
      true,
    );

    expect(built.requestData.prompt_cache_key).toBe('conv_123');
    expect('temperature' in built.requestData).toBe(false);
  } finally {
  }
});

it('Codex request capture records the exact normalized suffix projection without changing it', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const captures: any[] = [];
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        model: 'gpt-5-codex',
        previous_response_id: 'resp-1',
        input: [{ type: 'function_call_output', call_id: 'call-1', output: 'result' }],
        temperature: 0.2,
      },
    };
  };
  try {
    const model = new CodexResponsesModel(
      {} as any,
      'gpt-5-codex',
      undefined,
      {
        record: (projection) => captures.push(projection),
      },
      transport,
    );
    const built = (model as any).buildResponsesCreateRequest(
      { input: [], tools: [], codex: { promptCacheKey: 'cache-key' } },
      true,
    );

    expect(captures).toEqual([
      {
        provider: 'codex',
        transport: 'http',
        requestData: {
          model: 'gpt-5-codex',
          previous_response_id: 'resp-1',
          input: [{ type: 'function_call_output', call_id: 'call-1', output: 'result' }],
          prompt_cache_key: 'cache-key',
        },
      },
    ]);
    expect(built.requestData).toEqual(captures[0].requestData);
  } finally {
  }
});

it('CodexResponsesModel sends gpt-5.6-luna through the Responses Lite protocol', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        instructions: 'Follow the repository instructions.',
        input: [{ role: 'user', type: 'message', content: [{ type: 'text', text: 'Review this change.' }] }],
        tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
        parallel_tool_calls: true,
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5.6-luna', transport);
    const built = (model as any).buildResponsesCreateRequest({ input: [], tools: [] }, true);

    expect(built.requestData.instructions).toBe('');
    expect(built.requestData.tools).toBeUndefined();
    expect(built.requestData.parallel_tool_calls).toBe(false);
    expect(built.requestData.reasoning).toMatchObject({ context: 'all_turns' });
    expect(built.requestData.client_metadata).toEqual({ 'x-openai-internal-codex-responses-lite': 'true' });
    expect(built.requestData.input).toEqual([
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
      },
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'Follow the repository instructions.' }],
      },
      { role: 'user', type: 'message', content: [{ type: 'text', text: 'Review this change.' }] },
    ]);
  } finally {
  }
});

it('CodexResponsesModel does not resend Luna developer instructions on chained requests', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        previous_response_id: 'resp_previous',
        instructions: 'Follow the repository instructions.',
        input: [{ role: 'user', type: 'message', content: [{ type: 'text', text: 'Continue the review.' }] }],
        tools: [],
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5.6-luna', transport);
    const built = (model as any).buildResponsesCreateRequest({ input: [], tools: [] }, true);

    expect(built.requestData.input).toEqual([
      { type: 'additional_tools', role: 'developer', tools: [] },
      { role: 'user', type: 'message', content: [{ type: 'text', text: 'Continue the review.' }] },
    ]);
    expect(built.requestData.instructions).toBe('');
  } finally {
  }
});

it('CodexResponsesModel.buildResponsesCreateRequest strips replay item ids from input', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        input: [
          { id: 'msg_1', type: 'message', role: 'assistant', content: [] },
          { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'enc' },
          { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
          { id: 'ig_1', type: 'image_generation_call', status: 'completed', result: 'image' },
        ],
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const built = (model as any).buildResponsesCreateRequest({ input: [], tools: [] }, true);

    expect('id' in built.requestData.input[0]).toBe(false);
    expect('id' in built.requestData.input[1]).toBe(false);
    expect('id' in built.requestData.input[2]).toBe(false);
    expect(built.requestData.input[2].call_id).toBe('call_1');
    expect('id' in built.requestData.input[3]).toBe(false);
    expect(built.requestData.input[4].id).toBe('ig_1');
  } finally {
  }
});

it('CodexResponsesModel.buildResponsesCreateRequest drops the camelCase callId key after adding call_id', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  // codex.provider.ts's codexStream() builds tool_call/tool_result items as
  // `{ type: 'function_call', id: ... }` / `{ type: 'function_call_output', id: ... }`
  // (camelCase, no call_id) — the real shape a tool-call continuation sends.
  // The Responses API rejects unknown parameters, so leaving `callId` on the
  // object alongside the added `call_id` breaks every tool-call continuation.
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        input: [
          { type: 'function_call', callId: 'call_1', name: 'shell', arguments: '{}' },
          { type: 'function_call_output', callId: 'call_1', output: 'ok' },
        ],
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const built = (model as any).buildResponsesCreateRequest({ input: [], tools: [] }, true);

    expect(built.requestData.input[0]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'shell',
      arguments: '{}',
    });
    expect(built.requestData.input[1]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'ok',
    });
    expect('callId' in built.requestData.input[0]).toBe(false);
    expect('callId' in built.requestData.input[1]).toBe(false);
  } finally {
  }
});

it('CodexResponsesModel.buildResponsesCreateRequest drops unpaired function calls for stateless fallback', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        input: [
          { role: 'user', type: 'message', content: [{ type: 'text', text: 'continue' }] },
          { id: 'fc_1', type: 'function_call', call_id: 'call-paired', name: 'shell', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call-paired', output: 'ok' },
          { id: 'fc_2', type: 'function_call', call_id: 'call-orphan', name: 'shell', arguments: '{}' },
        ],
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const built = (model as any).buildResponsesCreateRequest({ input: [], tools: [] }, true);

    expect(built.requestData.previous_response_id).toBeUndefined();
    expect(built.requestData.input.map((item: any) => item.call_id).filter(Boolean)).toEqual([
      'call-paired',
      'call-paired',
    ]);
  } finally {
  }
});

it('CodexResponsesModel.buildResponsesCreateRequest keeps function calls for chained requests', () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.buildResponsesCreateRequest = function () {
    return {
      requestData: {
        previous_response_id: 'resp_123',
        input: [{ id: 'fc_1', type: 'function_call', call_id: 'call-server-held', name: 'shell', arguments: '{}' }],
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const built = (model as any).buildResponsesCreateRequest({ input: [], tools: [] }, true);

    expect(built.requestData.input).toEqual([
      { type: 'function_call', call_id: 'call-server-held', name: 'shell', arguments: '{}' },
    ]);
  } finally {
  }
});

it('CodexResponsesWSModel emits traffic logs for websocket streamed responses', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficCalls: Array<{ method: string; args: any }> = [];

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficCalls.push({ method: 'recordRequestStart', args: input });
    },
    async recordResponseReceived(input) {
      trafficCalls.push({ method: 'recordResponseReceived', args: input });
    },
    recordResponseClosed() {},
    recordRequestFailed(input) {
      trafficCalls.push({ method: 'recordRequestFailed', args: input });
    },
  };

  transport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.created', response: { id: 'resp_ws_traffic' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_ws_traffic',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hello WS traffic!' }],
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_ws_traffic',
          output: [],
          usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
        },
      },
    ]);
  };

  const sessionContextService = {
    getContext: () => ({
      sessionId: 'sess_ws_1',
      sessionStartedAt: '2025-01-01T00:00:00.000Z',
      mode: 'websocket',
      traceId: 'trace-session-1',
    }),
    runWithContext: <T>(_context: any, fn: () => T) => fn(),
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      mockProviderTraffic as any,
      sessionContextService as any,
      transport,
    );
    const request: any = { input: [], tools: [] };

    const events = await collect(model.stream(request));

    expect((events[events.length - 1] as any).type).toBe('completion');
    expect(trafficCalls.length).toBe(2);
    expect(trafficCalls[0].method).toBe('recordRequestStart');
    expect(trafficCalls[1].method).toBe('recordResponseReceived');
    expect(trafficCalls[0].args.requestId).toBe(trafficCalls[1].args.requestId);
    expect(trafficCalls[0].args.sessionId).toBeUndefined(); // Codex model doesn't pass sessionId directly
    expect(trafficCalls[0].args.headers.authorization).toBe('[REDACTED]');
    expect(trafficCalls[1].args.transport).toBe('websocket');
  } finally {
  }
});

it('CodexResponsesWSModel records a metadata-only outcome when a consumer closes a live stream', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficCalls: Array<{ method: string; args: any }> = [];
  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficCalls.push({ method: 'recordRequestStart', args: input });
    },
    async recordResponseReceived(input) {
      trafficCalls.push({ method: 'recordResponseReceived', args: input });
    },
    recordRequestFailed(input) {
      trafficCalls.push({ method: 'recordRequestFailed', args: input });
    },
    recordResponseClosed(input: any) {
      trafficCalls.push({ method: 'recordResponseClosed', args: input });
    },
  };

  transport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.created', response: { id: 'resp_ws_closed' } },
      { type: 'response.output_text.delta', delta: 'partial output must not be logged' },
    ]);
  };

  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    undefined,
    mockProviderTraffic,
    undefined,
    transport,
  );
  const iterator = model.stream({ input: [], tools: [] })[Symbol.asyncIterator]();

  expect(await iterator.next()).toMatchObject({
    value: { type: 'text_delta', text: 'partial output must not be logged' },
  });
  await iterator.return?.();

  expect(trafficCalls.map(({ method }) => method)).toEqual(['recordRequestStart', 'recordResponseClosed']);
  expect(trafficCalls[1].args).toMatchObject({ outcome: 'consumer_closed', eventCount: 2 });
  expect(JSON.stringify(trafficCalls[1].args)).not.toContain('partial output must not be logged');
});

it('CodexResponsesWSModel labels a consumer-closed stream as aborted when its request signal is aborted', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficCalls: Array<{ method: string; args: any }> = [];
  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart() {},
    async recordResponseReceived(input) {
      trafficCalls.push({ method: 'recordResponseReceived', args: input });
    },
    recordRequestFailed(input) {
      trafficCalls.push({ method: 'recordRequestFailed', args: input });
    },
    recordResponseClosed(input: any) {
      trafficCalls.push({ method: 'recordResponseClosed', args: input });
    },
  };

  transport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.created', response: { id: 'resp_ws_aborted' } },
      { type: 'response.output_text.delta', delta: 'partial output' },
    ]);
  };

  const controller = new AbortController();
  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    undefined,
    mockProviderTraffic,
    undefined,
    transport,
  );
  const iterator = model.stream({ input: [], tools: [], signal: controller.signal })[Symbol.asyncIterator]();

  await iterator.next();
  controller.abort();
  await iterator.return?.();

  expect(trafficCalls).toEqual([
    expect.objectContaining({ method: 'recordResponseClosed', args: expect.objectContaining({ outcome: 'aborted' }) }),
  ]);
});

it('CodexResponsesWSModel keeps provider stream failures on the existing failure path', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficCalls: Array<{ method: string; args: any }> = [];
  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficCalls.push({ method: 'recordRequestStart', args: input });
    },
    async recordResponseReceived(input) {
      trafficCalls.push({ method: 'recordResponseReceived', args: input });
    },
    recordResponseClosed(input) {
      trafficCalls.push({ method: 'recordResponseClosed', args: input });
    },
    recordRequestFailed(input) {
      trafficCalls.push({ method: 'recordRequestFailed', args: input });
    },
  };

  transport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.failed', response: { status: 'failed', error: { message: 'provider failed' } } },
    ]);
  };

  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    undefined,
    mockProviderTraffic,
    undefined,
    transport,
  );

  await expect(collect(model.stream({ input: [], tools: [] }))).rejects.toThrow('provider failed');
  expect(trafficCalls.map(({ method }) => method)).toEqual(['recordRequestStart', 'recordRequestFailed']);
});

it('CodexResponsesWSModel sends only new input after a Responses-Lite prefix is established', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficBodies: any[] = [];
  const captures: any[] = [];
  let responseCount = 0;

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficBodies.push(input.sentBody);
    },
    async recordResponseReceived() {},
    recordResponseClosed() {},
    recordRequestFailed() {},
  };

  transport.fetchResponse = async function () {
    responseCount += 1;
    return makeStream([
      {
        type: 'response.completed',
        response: { id: `resp_lite_${responseCount}`, output: [], usage: {} },
      },
    ]);
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5.6-luna',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
      undefined,
      mockProviderTraffic,
      {
        getContext: () => ({ sessionId: 'session-lite-prefix', traceId: 'trace-lite-prefix' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      } as any,
      undefined,
      { record: (projection) => captures.push(projection) },
      transport,
    );

    const tool = { type: 'function', name: 'shell', parameters: { type: 'object' } };
    const firstUserMessage = { role: 'user', type: 'message', content: [{ type: 'text', text: 'hello' }] };
    const secondUserMessage = {
      role: 'user',
      type: 'message',
      content: [{ type: 'text', text: 'how are you?' }],
    };

    await collect(
      model.stream({
        input: [firstUserMessage],
        instructions: 'Follow the repository instructions.',
        tools: [tool],
      } as any),
    );
    await collect(
      model.stream({
        previousResponseId: 'resp_lite_2',
        input: [secondUserMessage],
        instructions: 'Follow the repository instructions.',
        tools: [tool],
      } as any),
    );

    expect(trafficBodies).toHaveLength(3);
    expect(trafficBodies[0].input[0]).toMatchObject({ type: 'additional_tools', role: 'developer', tools: [tool] });
    expect(trafficBodies[1].previous_response_id).toBe('resp_lite_1');
    expect(trafficBodies[1].input).toEqual([
      expect.objectContaining({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }),
    ]);
    expect(trafficBodies[2].previous_response_id).toBe('resp_lite_2');
    expect(trafficBodies[2].input).toEqual([
      expect.objectContaining({ role: 'user', content: [{ type: 'input_text', text: 'how are you?' }] }),
    ]);
    expect(captures.map((capture) => capture.requestData)).toEqual(trafficBodies);
    expect(captures.map((capture) => capture.transport)).toEqual(['websocket', 'websocket', 'websocket']);
  } finally {
  }
});

it('CodexResponsesWSModel correlates Responses-Lite state across sequential streamed requests', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficBodies: any[] = [];
  let responseCount = 0;

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficBodies.push(input.sentBody);
    },
    async recordResponseReceived() {},
    recordResponseClosed() {},
    recordRequestFailed() {},
  };

  transport.fetchResponse = async function () {
    responseCount += 1;
    return makeStream([
      {
        type: 'response.completed',
        response: { id: `resp_token_${responseCount}`, output: [], usage: {} },
      },
    ]);
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5.6-luna',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
      undefined,
      mockProviderTraffic,
      {
        getContext: () => ({ sessionId: 'session-token', traceId: 'trace-token' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      } as any,
      transport,
    );

    const tool = { type: 'function', name: 'shell', parameters: { type: 'object' } };
    const msg1 = { role: 'user', type: 'message', content: [{ type: 'text', text: 'first' }] };
    const msg2 = { role: 'user', type: 'message', content: [{ type: 'text', text: 'second' }] };

    // First turn establishes the stored baseline.
    await collect(
      model.stream({
        input: [msg1],
        instructions: 'Do it.',
        tools: [tool],
      } as any),
    );

    // Second turn chains off the first.
    await collect(
      model.stream({
        previousResponseId: 'resp_token_2',
        input: [msg2],
        instructions: 'Do it.',
        tools: [tool],
      } as any),
    );

    // Traffic captures tell us the delta is correctly computed across turns.
    expect(trafficBodies).toHaveLength(3);
    // The third body (second turn's final request) should carry just the
    // new user message as a delta.
    expect(trafficBodies[2].previous_response_id).toBe('resp_token_2');
    expect(trafficBodies[2].input).toEqual([
      expect.objectContaining({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second' }] }),
    ]);
  } finally {
  }
});

it('CodexResponsesWSModel does not use wire state for non-Luna models', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.fetchResponse = async function () {
    return makeStream([{ type: 'response.completed', response: { id: 'resp_nonluna', output: [], usage: {} } }]);
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-nonluna', traceId: 'trace-nonluna' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      } as any,
      transport,
    );

    // Verify no tokens are stored for non-Luna requests.
    const built = (model as any).buildResponsesCreateRequest(
      {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [],
      },
      true,
    );

    // requestTokens WeakMap should not have an entry for the request.
    // The built requestData should not have been modified by wire state prep.
    expect(built.requestData.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    ]);
  } finally {
  }
});

it('CodexResponsesWSModel marks Luna websocket requests as Responses Lite', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  let seenRequest: any;
  transport.fetchResponse = async function (request: any) {
    seenRequest = request;
    return makeStream([{ type: 'response.completed', response: { id: 'resp_luna', output: [], usage: {} } }]);
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5.6-luna',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
      transport,
    );

    await collect(model.stream({ input: [], tools: [] }));

    expect(seenRequest.providerOptions.extraHeaders['x-openai-internal-codex-responses-lite']).toBe('true');
    expect(seenRequest.providerOptions.client_metadata).toEqual({
      ws_request_header_x_openai_internal_codex_responses_lite: 'true',
    });
  } finally {
  }
});

it('CodexResponsesWSModel sends Codex turn identity metadata for Luna', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  let seenRequest: any;
  transport.fetchResponse = async function (request: any) {
    seenRequest = request;
    return makeStream([{ type: 'response.completed', response: { id: 'resp_luna_identity', output: [], usage: {} } }]);
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5.6-luna',
      {
        getOrRefreshAccessToken: async () => 'token',
        getAccountId: () => 'acc_123',
        getInstallationId: () => 'installation-123',
      } as any,
      undefined,
      undefined,
      {
        getContext: () => ({
          sessionId: 'session-123',
          sessionStartedAt: '2025-01-01T00:00:00.000Z',
        }),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      } as any,
      transport,
    );

    await collect(model.stream({ input: [], tools: [] }));

    const providerData = seenRequest.providerOptions;
    expect(providerData.extraHeaders).toMatchObject({
      originator: 'codex_exec',
      'x-client-request-id': 'session-123',
      'session-id': 'session-123',
      'thread-id': 'session-123',
      'x-codex-window-id': 'session-123:1',
    });
    expect(providerData.client_metadata).toMatchObject({
      'x-codex-installation-id': 'installation-123',
      session_id: 'session-123',
      thread_id: 'session-123',
      'x-codex-window-id': 'session-123:1',
      ws_request_header_x_openai_internal_codex_responses_lite: 'true',
    });

    const turnMetadata = JSON.parse(providerData.client_metadata['x-codex-turn-metadata']);
    expect(turnMetadata).toMatchObject({
      installation_id: 'installation-123',
      session_id: 'session-123',
      thread_id: 'session-123',
      window_id: 'session-123:1',
      request_kind: 'turn',
    });
    expect(typeof turnMetadata.turn_id).toBe('string');
  } finally {
  }
});

it('CodexResponsesWSModel keeps turn identity stable across response continuations', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    return makeStream([
      { type: 'response.completed', response: { id: 'resp_stable_identity', output: [], usage: {} } },
    ]);
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5.6-luna',
      {
        getOrRefreshAccessToken: async () => 'token',
        getAccountId: () => 'acc_123',
        getInstallationId: () => 'installation-123',
      } as any,
      undefined,
      undefined,
      {
        getContext: () => ({
          sessionId: 'session-123',
          sessionStartedAt: '2025-01-01T00:00:00.000Z',
          traceId: 'turn-123',
        }),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      } as any,
      transport,
    );

    await collect(model.stream({ input: [], tools: [] }));
    await collect(
      model.stream({
        input: [],
        previousResponseId: 'resp_stable_identity',
        tools: [],
      }),
    );

    expect(seenRequests).toHaveLength(2);
    const firstMetadata = seenRequests[0].providerOptions.client_metadata;
    const secondMetadata = seenRequests[1].providerOptions.client_metadata;
    expect(JSON.parse(firstMetadata['x-codex-turn-metadata']).turn_id).toBe(
      JSON.parse(secondMetadata['x-codex-turn-metadata']).turn_id,
    );
    expect(seenRequests[0].providerOptions.extraHeaders['x-codex-turn-metadata']).toBe(
      seenRequests[1].providerOptions.extraHeaders['x-codex-turn-metadata'],
    );
  } finally {
  }
});

it('CodexResponsesWSModel logs reasoning and tool calls in choice payload matching HTTP/SSE logs', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficCalls: Array<{ method: string; args: any }> = [];

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficCalls.push({ method: 'recordRequestStart', args: input });
    },
    async recordResponseReceived(input) {
      trafficCalls.push({ method: 'recordResponseReceived', args: input });
    },
    recordResponseClosed() {},
    recordRequestFailed(input) {
      trafficCalls.push({ method: 'recordRequestFailed', args: input });
    },
  };

  transport.fetchResponse = async function () {
    return makeStream([
      { type: 'response.created', response: { id: 'resp_ws_reasoning_tool' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_123',
          text: 'Let me think about this request.',
          summary: [],
        },
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'fc_123',
          call_id: 'call_123',
          name: 'shell',
          arguments: '{"command":"ls"}',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_ws_reasoning_tool',
          output: [],
          usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
        },
      },
    ]);
  };

  const sessionContextService = {
    getContext: () => ({
      sessionId: 'sess_ws_2',
      sessionStartedAt: '2025-01-01T00:00:00.000Z',
      mode: 'websocket',
      traceId: 'trace-session-2',
    }),
    runWithContext: <T>(_context: any, fn: () => T) => fn(),
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      mockProviderTraffic as any,
      sessionContextService as any,
      transport,
    );
    const request: any = { input: [], tools: [] };

    await collect(model.stream(request));

    expect(trafficCalls.length).toBe(2);
    expect(trafficCalls[0].method).toBe('recordRequestStart');
    expect(trafficCalls[1].method).toBe('recordResponseReceived');

    const receivedInput = trafficCalls[1].args;
    expect(receivedInput.transport).toBe('websocket');
    expect(receivedInput.response).toBeTruthy();
    expect(receivedInput.response.id).toBe('resp_ws_reasoning_tool');
    expect(receivedInput.response.usage).toEqual({ input_tokens: 5, output_tokens: 6, total_tokens: 11 });
    expect(Array.isArray(receivedInput.response.output)).toBe(true);
  } finally {
  }
});

it('CodexResponsesModel unary path runs as stream under the hood', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  let receivedStreamArg = false;

  transport.fetchResponse = async function (_request: any, stream: boolean) {
    receivedStreamArg = stream;
    return makeStream([
      { type: 'response.created', response: { id: 'resp_unary' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_unary',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hello Unary!' }],
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_unary',
          output: [],
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        },
      },
    ]);
  };

  try {
    const model = new CodexResponsesModel({} as any, 'gpt-5-codex', transport);
    const request: any = { input: [], tools: [] };

    // Call getResponse which defaults to stream: false
    const response: any = await withTrace('test', () => (model as any).fetchUnaryResponse(request));

    expect(receivedStreamArg).toBe(true);
    expect(response.id).toBe('resp_unary');
    expect(response.output.length).toBe(1);
    expect(response.output[0].id).toBe('msg_unary');
    expect(response.usage.total_tokens).toBe(5);
  } finally {
  }
});

it('CodexResponsesWSModel unary path runs as stream under the hood', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  let receivedStreamArg = false;

  transport.fetchResponse = async function (_request: any, stream: boolean) {
    receivedStreamArg = stream;
    return makeStream([
      { type: 'response.created', response: { id: 'resp_ws_unary' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_ws_unary',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hello WS Unary!' }],
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_ws_unary',
          output: [],
          usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
        },
      },
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(mockClient as any, 'gpt-5-codex', tokenManager as any, transport);
    const request: any = { input: [], tools: [] };

    // Call getResponse which defaults to stream: false
    const response = await (model as any).fetchUnaryResponse(request);

    expect(receivedStreamArg).toBe(true);
    expect(response.id).toBe('resp_ws_unary');
    expect(response.output.length).toBe(1);
    expect(response.output[0].id).toBe('msg_ws_unary');
    expect(response.usage.total_tokens).toBe(7);
  } finally {
  }
});

it('wrapCodexStream throws a detailed stream error when receiving response.error event', async () => {
  const errorObj = { message: 'Some specific API error description' };
  const eventStream = wrapCodexStream(makeStream([{ type: 'response.error', error: errorObj }]));

  await expect(async () => {
    for await (const _ of eventStream) {
    }
  }).rejects.toThrow('Codex provider stream error: Some specific API error description');
});

it('wrapCodexStream throws when receiving response.error event without error field', async () => {
  const eventStream = wrapCodexStream(makeStream([{ type: 'response.error' }]));

  await expect(async () => {
    for await (const _ of eventStream) {
    }
  }).rejects.toThrow(/^Codex provider stream error:/);
});

it('wrapCodexStream throws a detailed provider error when receiving a failed response status', async () => {
  const errorObj = { message: 'Model context length exceeded' };
  const eventStream = wrapCodexStream(
    makeStream([
      {
        type: 'response.failed',
        response: {
          id: 'resp_failed_1',
          output: [],
          status: 'failed',
          error: errorObj,
        },
      },
    ]),
  );

  await expect(async () => {
    for await (const _ of eventStream) {
    }
  }).rejects.toThrow('Codex provider error: Model context length exceeded');
});

it('CodexResponsesWSModel injects Codex previous response id and trims replayed tool-continuation input', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const toolOutput = {
    type: 'tool_result',
    id: 'call-read',
    output: 'done',
  };
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: seenRequests.length === 1 ? 'resp-1' : 'resp-2',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-1', traceId: 'trace-1' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    for await (const _event of model.stream({
      input: [{ role: 'user', type: 'message', content: [{ type: 'text', text: 'inspect' }] }],
      tools: [],
    } as any)) {
    }

    expect(seenRequests.length).toBe(2);
    expect(seenRequests[0].providerOptions?.generate).toBe(false);
    expect(seenRequests[0].input).toEqual([]);
    expect(seenRequests[1].previousResponseId).toBe('resp-1');
    expect(seenRequests[1].input).toEqual([
      { role: 'user', type: 'message', content: [{ type: 'text', text: 'inspect' }] },
    ]);

    for await (const _event of model.stream({
      input: [
        { role: 'user', type: 'message', content: [{ type: 'text', text: 'inspect' }] },
        { role: 'assistant', type: 'message', content: [{ type: 'text', text: 'I will inspect it.' }] },
        { type: 'function_call', call_id: 'call-read', name: 'read_file', arguments: '{}' },
        toolOutput,
      ],
      tools: [],
    } as any)) {
    }

    expect(seenRequests.length).toBe(3);
    expect(seenRequests[2].previousResponseId).toBe('resp-2');
    expect(seenRequests[2].input).toEqual([toolOutput]);

    const latestUser = { type: 'message', role: 'user', content: [{ type: 'text', text: 'summarize' }] };
    for await (const _event of model.stream({
      previousResponseId: 'resp-explicit',
      input: [
        { role: 'user', type: 'message', content: [{ type: 'text', text: 'inspect' }] },
        { role: 'assistant', type: 'message', content: [{ type: 'text', text: 'Done.' }] },
        latestUser,
      ],
      tools: [],
    } as any)) {
    }

    expect(seenRequests.length).toBe(4);
    expect(seenRequests[3].previousResponseId).toBe('resp-explicit');
    expect(seenRequests[3].input).toEqual([latestUser]);
  } finally {
  }
});

it('CodexResponsesWSModel isolates implicit response history for logical runs sharing a foreground session', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const sessionContextService = new SessionContextService();
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    const userMessage = request.input?.find((item: any) => item?.role === 'user');
    const userText = Array.isArray(userMessage?.content) ? userMessage.content[0]?.text : userMessage?.content;
    const responseId =
      userText === 'chain-a' ? 'resp-chain-a' : userText === 'chain-b' ? 'resp-chain-b' : `resp-${seenRequests.length}`;
    return makeStream([
      {
        type: 'response.completed',
        response: { id: responseId, output: [], usage: {} },
      } as any,
    ]);
  };

  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    {
      getOrRefreshAccessToken: async () => 'token',
      getAccountId: () => 'acc_123',
    } as any,
    undefined,
    undefined,
    sessionContextService,
    transport,
  );
  const contextFor = (providerHistoryKey: string) => ({
    sessionId: 'shared-parent-session',
    sessionStartedAt: '2026-07-13T00:00:00.000Z',
    providerHistoryKey,
  });
  const openChain = async (chain: string) => {
    await collect(
      model.stream({
        input: [{ role: 'user', type: 'message', content: [{ type: 'text', text: chain }] }],
        tools: [],
      } as any),
    );
  };

  try {
    await sessionContextService.runWithContext(contextFor('nested-run-a'), () => openChain('chain-a'));
    await sessionContextService.runWithContext(contextFor('nested-run-b'), () => openChain('chain-b'));

    const toolOutput = {
      type: 'tool_result',
      id: 'call-a',
      output: 'result-a',
    };
    await sessionContextService.runWithContext(contextFor('nested-run-a'), () =>
      collect(
        model.stream({
          input: [
            { role: 'user', type: 'message', content: [{ type: 'text', text: 'chain-a' }] },
            { type: 'function_call', call_id: 'call-a', name: 'read_file', arguments: '{}' },
            toolOutput,
          ],
          tools: [],
        } as any),
      ),
    );

    const continuation = seenRequests.at(-1);
    expect(continuation.previousResponseId).toBe('resp-chain-a');
    expect(continuation.input).toEqual([toolOutput]);
  } finally {
  }
});

it('CodexResponsesWSModel keeps every interleaved parallel tool output when trimming a tool-continuation delta', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: 'resp-paired',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  // A prior Codex response issued five parallel function calls — four
  // read_code_outline calls plus a shell. The reconstructed continuation
  // history pairs each call with its result, and the shell pair lands last
  // (it ran after the reads). Only that final result forms a contiguous
  // trailing run, so the legacy delta trim kept just the shell output and
  // dropped the four read outputs, which the server rejected with a 400
  // ("No tool output found for function call …"). The fix must keep every
  // output whose call was produced by the previous response.
  const parallelReads = [1, 2, 3, 4].map((n) => ({
    call: { type: 'function_call', call_id: `call-read-${n}`, name: 'read_code_outline', arguments: '{}' },
    output: { type: 'tool_result', id: `call-read-${n}`, output: `outline-${n}` },
  }));
  const shellPair = {
    call: { type: 'tool_call', id: 'call-shell', name: 'shell', arguments: '{}' },
    output: { type: 'tool_result', id: 'call-shell', output: 'grep result' },
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-1', traceId: 'trace-1' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    for await (const _event of model.stream({
      previousResponseId: 'resp-prev',
      input: [
        { role: 'user', type: 'message', content: [{ type: 'text', text: 'inspect the repo' }] },
        { role: 'assistant', type: 'message', content: [{ type: 'text', text: 'I will inspect it.' }] },
        ...parallelReads.flatMap((pair) => [pair.call, pair.output]),
        shellPair.call,
        shellPair.output,
      ],
      tools: [],
    } as any)) {
    }

    expect(seenRequests.length).toBe(1);
    expect(seenRequests[0].previousResponseId).toBe('resp-prev');
    expect(seenRequests[0].input).toEqual([...parallelReads.map((pair) => pair.output), shellPair.output]);
  } finally {
  }
});

it('CodexResponsesWSModel drops tool outputs already consumed by the previous response', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    const responseIds = ['resp-after-first-batch', 'resp-after-second-batch', 'resp-after-third-batch'];
    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: responseIds[seenRequests.length - 1],
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  const firstBatch = [1, 2].map((n) => ({
    type: 'tool_result',
    id: `call-already-sent-${n}`,
    output: `old-${n}`,
  }));
  const nextOutput = {
    type: 'tool_result',
    id: 'call-current',
    output: 'current',
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-consumed-tool-outputs', traceId: 'trace-1' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    for await (const _event of model.stream({
      previousResponseId: 'resp-tool-calls-1',
      input: firstBatch,
      tools: [],
    } as any)) {
    }

    for await (const _event of model.stream({
      previousResponseId: 'resp-after-first-batch',
      input: [...firstBatch, nextOutput],
      tools: [],
    } as any)) {
    }

    for await (const _event of model.stream({
      previousResponseId: 'resp-after-second-batch',
      input: [nextOutput],
      tools: [],
    } as any)) {
    }

    expect(seenRequests.length).toBe(3);
    expect(seenRequests[0].previousResponseId).toBe('resp-tool-calls-1');
    expect(seenRequests[0].input).toEqual(firstBatch);
    expect(seenRequests[1].previousResponseId).toBe('resp-after-first-batch');
    expect(seenRequests[1].input).toEqual([nextOutput]);
    expect(seenRequests[2].previousResponseId).toBe('resp-after-second-batch');
    expect(seenRequests[2].input).toEqual([]);
  } finally {
  }
});

it('CodexResponsesWSModel marks transport failure after buffered raw frames as ambiguous', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  let attempts = 0;
  const networkError = new Error('Responses websocket connection closed before response completed (code=1006)');
  transport.fetchResponse = async function () {
    attempts += 1;
    return (async function* () {
      yield { type: 'response.reasoning_summary_text.delta', delta: 'buffered reasoning' };
      throw networkError;
    })();
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
      transport,
    );
    const retrying = new RetryingModel(model, { retryAttempts: 2, sleep: async () => {} });

    await expect(
      collect(
        retrying.stream({
          input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
          tools: [],
        }),
      ),
    ).rejects.toBeInstanceOf(AmbiguousModelOutcomeError);
    expect(attempts).toBe(1);
  } finally {
  }
});

it('CodexResponsesWSModel marks close before terminal as ambiguous even without raw frames', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  let attempts = 0;
  // Incomplete-stream class: transportFallback stays false, but the request may
  // already have been accepted — RetryingModel must not replay.
  const closeError = new Error('Codex WebSocket connection closed before a terminal response event.');
  transport.fetchResponse = async function () {
    attempts += 1;
    return (async function* () {
      throw closeError;
    })();
  };

  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    transport,
  );
  const retrying = new RetryingModel(model, { retryAttempts: 2, sleep: async () => {} });

  await expect(
    collect(
      retrying.stream({
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [],
      }),
    ),
  ).rejects.toMatchObject({
    name: 'AmbiguousModelOutcomeError',
    unsafeToReplay: true,
  });
  expect(attempts).toBe(1);
});

it('CodexResponsesWSModel drops interleaved tool calls from an already-trimmed tool-continuation delta', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: 'resp-trimmed-paired',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };
  const pairs = [1, 2].map((n) => ({
    call: { type: 'function_call', call_id: `call-${n}`, name: 'read_code_outline', arguments: '{}' },
    output: { type: 'tool_result', id: `call-${n}`, output: `outline-${n}` },
  }));

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-1', traceId: 'trace-1' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    for await (const _event of model.stream({
      previousResponseId: 'resp-prev',
      input: pairs.flatMap((pair) => [pair.call, pair.output]),
      tools: [],
    } as any)) {
    }

    expect(seenRequests.length).toBe(1);
    expect(seenRequests[0].previousResponseId).toBe('resp-prev');
    expect(seenRequests[0].input).toEqual(pairs.map((pair) => pair.output));
  } finally {
  }
});

it('CodexResponsesWSModel keeps interleaved outputs when function calls only carry item ids', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: 'resp-item-id-paired',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };
  const pairs = [1, 2, 3].map((n) => ({
    call: { type: 'function_call', id: `fc-${n}`, name: 'shell', arguments: '{}' },
    output: { type: 'tool_result', id: `call-${n}`, output: `result-${n}` },
  }));

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-1', traceId: 'trace-1' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    for await (const _event of model.stream({
      previousResponseId: 'resp-prev',
      input: pairs.flatMap((pair) => [pair.call, pair.output]),
      tools: [],
    } as any)) {
    }

    expect(seenRequests.length).toBe(1);
    expect(seenRequests[0].previousResponseId).toBe('resp-prev');
    expect(seenRequests[0].input).toEqual(pairs.map((pair) => pair.output));
  } finally {
  }
});

it('CodexResponsesWSModel warms interleaved tool continuations into history before sending the delta', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: seenRequests.length === 1 ? 'resp-warmup' : 'resp-main',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  const openingUser = { type: 'message', role: 'user', content: [{ type: 'text', text: 'inspect the repo' }] };
  const openingAssistant = {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'I will inspect it.' }],
  };
  const parallelReads = [1, 2].map((n) => ({
    call: { type: 'tool_call', id: `call-read-${n}`, name: 'read_code_outline', arguments: '{}' },
    output: { type: 'tool_result', id: `call-read-${n}`, output: `outline-${n}` },
  }));
  const shellPair = {
    call: { type: 'tool_call', id: 'call-shell', name: 'shell', arguments: '{}' },
    output: { type: 'tool_result', id: 'call-shell', output: 'grep result' },
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-1', traceId: 'trace-1' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    for await (const _event of model.stream({
      input: [
        openingUser,
        openingAssistant,
        ...parallelReads.flatMap((pair) => [pair.call, pair.output]),
        shellPair.call,
        shellPair.output,
      ],
      tools: [],
    } as any)) {
    }

    expect(seenRequests.length).toBe(2);
    expect(seenRequests[0].providerOptions?.generate).toBe(false);
    expect(seenRequests[0].previousResponseId).toBe(undefined);
    expect(seenRequests[0].input).toEqual([
      openingUser,
      openingAssistant,
      ...parallelReads.map((pair) => pair.call),
      shellPair.call,
    ]);
    expect(seenRequests[1].previousResponseId).toBe('resp-warmup');
    expect(seenRequests[1].input).toEqual([...parallelReads.map((pair) => pair.output), shellPair.output]);
  } finally {
  }
});

it('CodexResponsesWSModel leaves warmup connection failures to the outer retry policy', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const networkError = Object.assign(new Error('Responses websocket connection closed before opening.'), {
    code: 'connection_closed_before_opening',
  });
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    if (seenRequests.length === 1) {
      throw networkError;
    }

    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: 'resp-full-history',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };
  const fullInput = [
    { role: 'user', type: 'message', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', type: 'message', content: [{ type: 'text', text: 'first response' }] },
    { role: 'user', type: 'message', content: [{ type: 'text', text: 'next' }] },
  ];

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-warmup-repro', traceId: 'trace-warmup-repro' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    await expect(async () => {
      for await (const _event of model.stream({
        input: fullInput,
        tools: [],
      } as any)) {
      }
    }).rejects.toBe(networkError);

    expect(seenRequests.length).toBe(1);
    expect(seenRequests[0].providerOptions?.generate).toBe(false);
  } finally {
  }
});

it('CodexResponsesWSModel preserves a tool-call chain when the websocket connection lifetime expires', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const trafficBodies: any[] = [];
  const networkError = Object.assign(
    new Error(
      'Responses websocket error: {"error":{"code":"websocket_connection_limit_reached","message":"Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue."},"status":400}',
    ),
    { status: 400 },
  );
  const functionCall = {
    id: 'fc_1',
    type: 'function_call',
    call_id: 'call_tool_1',
    name: 'run_subagent_async',
    arguments: '{}',
  };
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    if (seenRequests.length === 1) {
      return makeStream([
        {
          type: 'response.completed',
          response: {
            id: 'resp-tool-call',
            output: [functionCall],
            usage: {},
          },
        } as any,
      ]);
    }

    if (seenRequests.length === 2) {
      throw networkError;
    }

    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: 'resp-recovered',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficBodies.push(input.sentBody);
    },
    async recordResponseReceived() {},
    recordResponseClosed() {},
    recordRequestFailed() {},
  };
  const continuationInput = [
    { role: 'user', type: 'message', content: [{ type: 'text', text: 'start the worker' }] },
    {
      type: 'tool_result',
      id: 'call_tool_1',
      output: 'worker is running',
    },
  ];

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5.6-luna',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
      undefined,
      mockProviderTraffic,
      {
        getContext: () => ({ sessionId: 'session-network-repro', traceId: 'trace-network-repro' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    await collect(
      model.stream({
        previousResponseId: 'resp-root',
        input: [{ role: 'user', type: 'message', content: [{ type: 'text', text: 'start the worker' }] }],
        tools: [],
      } as any),
    );

    await expect(
      collect(
        model.stream({
          input: continuationInput,
          tools: [],
        } as any),
      ),
    ).rejects.toBe(networkError);

    expect(trafficBodies).toHaveLength(2);
    expect(trafficBodies[1].previous_response_id).toBe('resp-tool-call');
    expect(trafficBodies[1].input).toEqual([
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_tool_1' }),
    ]);

    await collect(
      model.stream({
        input: continuationInput,
        tools: [],
      } as any),
    );

    expect(seenRequests).toHaveLength(3);
    expect(trafficBodies).toHaveLength(3);
    expect(trafficBodies[2].previous_response_id).toBe('resp-tool-call');
    expect(trafficBodies[2].input).toEqual([
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_tool_1',
        output: 'worker is running',
      }),
    ]);
    expect(trafficBodies[2].input).not.toContainEqual(expect.objectContaining({ type: 'function_call' }));
    expect(trafficBodies[2].generate).not.toBe(false);
  } finally {
  }
});

it('CodexResponsesWSModel preserves tool output when a user steer message follows tool results mid-turn', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5.6-luna', false);
  const trafficBodies: any[] = [];
  let requestCount = 0;
  transport.fetchResponse = async function (request: any, stream: boolean, requestData: any) {
    requestCount++;
    if (requestCount === 1) {
      return makeStream([
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            id: 'call_dUY49XDM2PcYLUlN0vQzCeKO',
            call_id: 'call_dUY49XDM2PcYLUlN0vQzCeKO',
            name: 'shell',
            arguments: '{"command":"ls"}',
          },
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-tool-call',
            output: [
              {
                type: 'function_call',
                id: 'call_dUY49XDM2PcYLUlN0vQzCeKO',
                call_id: 'call_dUY49XDM2PcYLUlN0vQzCeKO',
                name: 'shell',
                arguments: '{"command":"ls"}',
              },
            ],
          },
        },
      ]);
    }
    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: 'resp-steered-turn',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Steer processed' }] }],
        },
      },
    ]);
  };

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficBodies.push(input.sentBody);
    },
    async recordResponseReceived() {},
    recordResponseClosed() {},
    recordRequestFailed() {},
  };

  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5.6-luna',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
    undefined,
    mockProviderTraffic,
    {
      getContext: () => ({ sessionId: 'session-steer-test', traceId: 'trace-steer-test' } as any),
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
    },
    transport,
  );

  // Turn 1: initial user message
  await collect(
    model.stream({
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'initial question' }] }],
      tools: [],
    } as any),
  );

  // Turn 2: tool result + steer message injected mid-turn
  const steeredInput = [
    { type: 'message', role: 'user', content: [{ type: 'text', text: 'initial question' }] },
    { type: 'tool_call', id: 'call_dUY49XDM2PcYLUlN0vQzCeKO', name: 'shell', arguments: '{"command":"ls"}' },
    { type: 'tool_result', id: 'call_dUY49XDM2PcYLUlN0vQzCeKO', output: 'file1.txt\nfile2.txt' },
    { type: 'message', role: 'user', content: [{ type: 'text', text: 'steering message injected mid-turn' }] },
  ];

  await collect(
    model.stream({
      input: steeredInput,
      previousResponseId: 'resp-tool-call',
      tools: [],
    } as any),
  );

  expect(trafficBodies).toHaveLength(3);
  expect(trafficBodies[2].previous_response_id).toBe('resp-tool-call');
  expect(trafficBodies[2].input).toEqual([
    expect.objectContaining({
      type: 'additional_tools',
    }),
    expect.objectContaining({
      type: 'function_call_output',
      call_id: 'call_dUY49XDM2PcYLUlN0vQzCeKO',
      output: 'file1.txt\nfile2.txt',
    }),
    expect.objectContaining({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'steering message injected mid-turn' }],
    }),
  ]);
});

it('CodexResponsesWSModel invalidates Luna wire state on previous_response_not_found error', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  let rejectedChainedContinuation = false;
  const prevNotFoundError = Object.assign(new Error('Previous response not found for id resp_stale'), {
    code: 'previous_response_not_found',
  });
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);

    const isChainedContinuation =
      request.previousResponseId === 'resp_luna_ok' &&
      request.input?.some((item: any) => item?.content?.[0]?.text === 'continue');
    if (isChainedContinuation && !rejectedChainedContinuation) {
      rejectedChainedContinuation = true;
      throw prevNotFoundError;
    }

    return makeStream([
      {
        type: 'response.completed',
        response: { id: 'resp_luna_ok', output: [], usage: {} },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5.6-luna',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-luna-err', traceId: 'trace-luna-err' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    const userMsg = { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] };
    const userMsg2 = { type: 'message', role: 'user', content: [{ type: 'text', text: 'continue' }] };

    // First request: succeeds, establishes stored state.
    await collect(
      model.stream({
        input: [userMsg],
        instructions: 'Do it.',
        tools: [],
      } as any),
    );

    // Second request: chains off the first, but fails with prev-not-found.
    // The error triggers invalidation, then the fallback sends full input.
    await collect(
      model.stream({
        previousResponseId: 'resp_luna_ok',
        input: [userMsg, userMsg2],
        instructions: 'Do it.',
        tools: [],
      } as any),
    );

    // After invalidation, the exact fallback request replays full history
    // without trying to continue the stale response chain.
    expect(rejectedChainedContinuation).toBe(true);
    const failedRequestIndex = seenRequests.findIndex(
      (candidate) =>
        candidate.previousResponseId === 'resp_luna_ok' &&
        candidate.input?.some((item: any) => item?.content?.[0]?.text === 'continue'),
    );
    const fallbackRequests = seenRequests.slice(failedRequestIndex + 1);
    expect(fallbackRequests).not.toHaveLength(0);
    expect(fallbackRequests[0].previousResponseId).toBeUndefined();
    expect(fallbackRequests.flatMap((candidate) => candidate.input)).toEqual(
      expect.arrayContaining([userMsg, userMsg2]),
    );
  } finally {
  }
});

it('CodexResponsesWSModel propagates stale tool continuations instead of replaying orphaned outputs', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const previousResponseNotFound = Object.assign(new Error('Previous response not found for id resp-stale'), {
    code: 'previous_response_not_found',
  });
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    throw previousResponseNotFound;
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-stale-tool', traceId: 'trace-stale-tool' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    await expect(
      collect(
        model.stream({
          previousResponseId: 'resp-stale',
          input: [
            { role: 'user', type: 'message', content: [{ type: 'text', text: 'inspect the repo' }] },
            {
              type: 'tool_result',
              id: 'call-orphaned-output',
              output: 'tool output from the missing response',
            },
          ],
          tools: [],
        } as any),
      ),
    ).rejects.toMatchObject({ code: 'previous_response_not_found' });

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].previousResponseId).toBe('resp-stale');
  } finally {
  }
});

it('CodexResponsesWSModel drops orphaned tool outputs before creating a warmup chain', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const serverCallIds = new Set<string>();
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    for (const item of request.input ?? []) {
      if (item?.type === 'function_call' && typeof item.callId === 'string') {
        serverCallIds.add(item.callId);
      }
      if (item?.type === 'function_call_result' && typeof item.callId === 'string' && !serverCallIds.has(item.callId)) {
        throw new Error(`No tool call found for function call output with call_id ${item.callId}.`);
      }
    }

    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: request.providerOptions?.generate === false ? 'resp-warmup' : 'resp-completed',
          output: [],
          usage: {},
        },
      },
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-orphan-warmup', traceId: 'trace-orphan-warmup' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    await collect(
      model.stream({
        input: [
          { role: 'user', type: 'message', content: [{ type: 'text', text: 'inspect the repo' }] },
          { type: 'reasoning', content: [] },
          {
            type: 'tool_result',
            id: 'call-orphaned-output',
            output: 'tool output from a discarded response chain',
          },
        ],
        tools: [],
      } as any),
    );

    expect(seenRequests.flatMap((request) => request.input ?? [])).not.toContainEqual(
      expect.objectContaining({ id: 'call-orphaned-output' }),
    );
  } finally {
  }
});

it('CodexResponsesWSModel does not chain a tool output whose call is absent from a rebuilt response chain', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const orphanedCallId = 'call-rebuilt-chain-orphan';
  const functionCall = {
    type: 'tool_call',
    id: orphanedCallId,
    name: 'apply_patch',
    arguments: '{}',
  };
  const functionCallOutput = {
    type: 'tool_result',
    id: orphanedCallId,
    output: 'Updated source/providers/openai.provider.ts',
    status: 'completed',
  };
  const noToolCallForOutput = new Error(`No tool call found for function call output with call_id ${orphanedCallId}.`);
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    if (request.input?.some((item: any) => (item?.call_id ?? item?.callId) === orphanedCallId)) {
      throw noToolCallForOutput;
    }
    return makeStream([
      {
        type: 'response.completed',
        response: {
          id: 'resp-rebuilt-chain',
          output: [],
          usage: {},
        },
      } as any,
    ]);
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };
  const openingUser = { type: 'message', role: 'user', content: [{ type: 'text', text: 'inspect the repo' }] };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-rebuilt-chain-orphan', traceId: 'trace-rebuilt-chain-orphan' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    // The rebuilt chain is established without the in-flight function call.
    await collect(
      model.stream({
        input: [openingUser],
        tools: [],
      } as any),
    );

    await expect(
      collect(
        model.stream({
          previousResponseId: 'resp-rebuilt-chain',
          input: [openingUser, functionCall, functionCallOutput],
          tools: [],
        } as any),
      ),
    ).rejects.toMatchObject({
      name: 'OrphanedChainedToolOutputError',
      callIds: [orphanedCallId],
    });

    expect(seenRequests).toHaveLength(2);
    expect(seenRequests).not.toContainEqual(
      expect.objectContaining({
        input: expect.arrayContaining([expect.objectContaining({ id: orphanedCallId })]),
      }),
    );
  } finally {
  }
});

it('CodexResponsesWSModel unary path propagates stale tool continuations without fallback', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const seenRequests: any[] = [];
  const previousResponseNotFound = Object.assign(new Error('Previous response not found for id resp-stale-unary'), {
    code: 'previous_response_not_found',
  });
  transport.fetchResponse = async function (request: any) {
    seenRequests.push(request);
    throw previousResponseNotFound;
  };

  const mockClient = {
    baseURL: 'https://api.openai.com',
    apiKey: 'test-key',
    _options: {},
  };
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'token',
    getAccountId: () => 'acc_123',
  };

  try {
    const model = new CodexResponsesWSModel(
      mockClient as any,
      'gpt-5-codex',
      tokenManager as any,
      undefined,
      undefined,
      {
        getContext: () => ({ sessionId: 'session-stale-tool-unary', traceId: 'trace-stale-tool-unary' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      },
      transport,
    );

    await expect(
      (model as any).fetchUnaryResponse({
        previousResponseId: 'resp-stale-unary',
        input: [
          { role: 'user', type: 'message', content: [{ type: 'text', text: 'inspect the repo' }] },
          {
            type: 'tool_result',
            id: 'call-orphaned-output-unary',
            output: 'tool output from the missing response',
          },
        ],
        tools: [],
      } as any),
    ).rejects.toMatchObject({ code: 'previous_response_not_found' });

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].previousResponseId).toBe('resp-stale-unary');
  } finally {
  }
});

it('CodexResponsesWSModel unary path records Luna wire state response with correct token', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const trafficBodies: any[] = [];
  let responseCount = 0;

  const mockProviderTraffic: IProviderTraffic = {
    recordRequestStart(input) {
      trafficBodies.push(input.sentBody);
    },
    async recordResponseReceived() {},
    recordResponseClosed() {},
    recordRequestFailed() {},
  };

  transport.fetchResponse = async function () {
    responseCount += 1;
    return makeStream([
      {
        type: 'response.completed',
        response: { id: `resp_unary_luna_${responseCount}`, output: [], usage: {} },
      },
    ]);
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5.6-luna',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => 'acc_123' } as any,
      undefined,
      mockProviderTraffic,
      {
        getContext: () => ({ sessionId: 'session-unary-token', traceId: 'trace-unary-token' } as any),
        runWithContext: <T>(_context: any, fn: () => T) => fn(),
      } as any,
      transport,
    );

    const msg1 = { role: 'user', type: 'message', content: [{ type: 'text', text: 'unary first' }] };
    const msg2 = { role: 'user', type: 'message', content: [{ type: 'text', text: 'unary second' }] };

    // First unary call establishes stored state.
    await (model as any).fetchUnaryResponse({
      input: [msg1],
      instructions: 'Do it.',
      tools: [],
    } as any);

    // Second unary call chains off first and should produce a delta.
    await (model as any).fetchUnaryResponse({
      previousResponseId: 'resp_unary_luna_2',
      input: [msg2],
      instructions: 'Do it.',
      tools: [],
    } as any);

    // The second call's final request body (third traffic entry) should
    // carry only the new user message as a delta.
    expect(trafficBodies).toHaveLength(3);
    expect(trafficBodies[2].previous_response_id).toBe('resp_unary_luna_2');
    expect(trafficBodies[2].input).toEqual([
      expect.objectContaining({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'unary second' }],
      }),
    ]);
  } finally {
  }
});

it('CodexResponsesWSModel gives the SDK a composed request signal before receiving websocket events', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  const external = new AbortController();
  let sdkSignal: AbortSignal | undefined;
  transport.fetchResponse = async function (request: any) {
    sdkSignal = request.signal;
    return makeStream([{ type: 'response.completed', response: { id: 'resp_1', output: [], usage: {} } }]);
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => undefined } as any,
      transport,
    );

    await collect(
      model.stream({
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [],
        signal: external.signal,
      } as any),
    );

    expect(sdkSignal).toBeDefined();
    expect(sdkSignal).not.toBe(external.signal);
    expect(sdkSignal?.aborted).toBe(false);
  } finally {
  }
});

it('CodexResponsesWSModel applies configured websocket receive timeouts', async () => {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  vi.useFakeTimers();
  const external = new AbortController();
  let sdkSignal: AbortSignal | undefined;
  transport.fetchResponse = async function (request: any) {
    sdkSignal = request.signal;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  };

  try {
    const model = new CodexResponsesWSModel(
      { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
      'gpt-5-codex',
      { getOrRefreshAccessToken: async () => 'token', getAccountId: () => undefined } as any,
      undefined,
      undefined,
      undefined,
      { firstFrameMs: 25, interFrameMs: 50 },
      transport,
    );
    const pending = collect(
      model.stream({
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [],
        signal: external.signal,
      } as any),
    );
    void pending.catch(() => {});

    await vi.advanceTimersByTimeAsync(25);
    expect(sdkSignal?.aborted).toBe(true);
    expect(sdkSignal?.reason).toBeInstanceOf(Error);
    expect((sdkSignal?.reason as Error).message).toBe('WebSocket first frame timeout');
  } finally {
    external.abort();
    vi.useRealTimers();
  }
});
