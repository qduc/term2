import { it, expect } from 'vitest';
import { LoggingService } from './logging/logging-service.js';
import {
  createStreamAccumulator,
  processStreamEvents,
  type StreamProcessorOptions,
  type StreamProcessorDeps,
} from './stream-event-processor.js';
import { adaptAgentStream, type AgentStream } from './agent-stream.js';
import { ApplicationRunLoop } from './agent-runtime/application-run-loop.js';
import type { StreamedModelTurn } from '../contracts/streamed-model-turn.js';

const logger = new LoggingService({ disableLogging: true });

const makeStream = (events: unknown[], extras: any = {}): AgentStream => {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    completed: Promise.resolve(extras.completed ?? null),
    ...extras,
  } as any;
};

const baseOpts = (): StreamProcessorOptions => ({
  toolCallArgumentsById: new Map(),
  emittedInvalidToolCallPackets: new Set(),
  preserveExistingToolArgs: false,
});

const baseDeps = (): StreamProcessorDeps => ({ logger, sessionId: 'test-session' });

it('emits text_delta events with accumulated fullText', async () => {
  const stream = makeStream([
    { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'Hello' } },
    { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: ' world' } },
  ]);
  const acc = createStreamAccumulator();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    events.push(ev);
  }

  const textEvents = events.filter((e) => e.type === 'text_delta');
  expect(textEvents.length).toBe(2);
  expect(textEvents[0].delta).toBe('Hello');
  expect(textEvents[0].fullText).toBe('Hello');
  expect(textEvents[1].fullText).toBe('Hello world');
  expect(acc.finalOutput).toBe('Hello world');
  expect(acc.textDeltaCount).toBe(2);
});

it('preserves newline between code fence language and first code line across text deltas', async () => {
  const stream = makeStream([
    { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: '```typescript' } },
    { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: '\n' } },
    { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'if (enabled) {\n' } },
    { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: '  run();\n}\n```' } },
  ]);
  const acc = createStreamAccumulator();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    events.push(ev);
  }

  expect(acc.finalOutput).toBe('```typescript\nif (enabled) {\n  run();\n}\n```');
  expect(events.some((e) => e.type === 'text_delta' && e.fullText === '```typescript\nif (enabled) {\n')).toBe(true);
});

it('extracts text once from nested and direct model envelopes', async () => {
  const stream = makeStream([
    { type: 'raw_model_stream_event', data: { type: 'model', event: { type: 'output_text_delta', delta: 'nested' } } },
    { type: 'model', event: { type: 'output_text_delta', delta: ' direct' } },
  ]);
  const events: any[] = [];
  for await (const event of processStreamEvents(stream, createStreamAccumulator(), baseOpts(), baseDeps())) {
    events.push(event);
  }

  expect(events.filter((event) => event.type === 'text_delta')).toEqual([
    { type: 'text_delta', delta: 'nested', fullText: 'nested' },
    { type: 'text_delta', delta: ' direct', fullText: 'nested direct' },
  ]);
});

it('preserves provider reasoning and completed tool-call progress through ApplicationRunLoop', async () => {
  let calls = 0;
  const model: StreamedModelTurn = {
    async *stream() {
      calls++;
      if (calls === 1) {
        yield { type: 'reasoning_delta', text: 'thinking about the command' };
        yield { type: 'tool_call', id: 'call-1', name: 'probe', arguments: '{"value":"ok"}' };
        yield {
          type: 'completion',
          responseId: 'response-tool',
          output: [{ type: 'tool_call', id: 'call-1', name: 'probe', arguments: '{"value":"ok"}' }],
        };
        return;
      }
      yield {
        type: 'completion',
        responseId: 'response-done',
        output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
      };
    },
  };
  const stream = new ApplicationRunLoop({ resolveModel: () => model }).startStream(
    {
      name: 'test-agent',
      instructions: 'Be concise.',
      model: 'test-model',
      tools: [
        {
          name: 'probe',
          description: 'fixture probe',
          parameters: { type: 'object' },
          needsApproval: async () => false,
          formatCommandMessage: () => [],
          execute: async () => 'fixture result',
        },
      ],
    },
    'prompt',
  );
  const events: any[] = [];
  for await (const event of processStreamEvents(stream, createStreamAccumulator(), baseOpts(), baseDeps())) {
    events.push(event);
  }

  expect(stream.output).toEqual(
    expect.arrayContaining([
      { type: 'reasoning_delta', text: 'thinking about the command' },
      expect.objectContaining({ type: 'item', item: expect.objectContaining({ type: 'function_call' }) }),
    ]),
  );
  expect(events.filter((event) => event.type === 'reasoning_delta')).toEqual([
    { type: 'reasoning_delta', delta: 'thinking about the command', fullText: 'thinking about the command' },
  ]);
  expect(events.filter((event) => event.type === 'tool_started')).toEqual([
    {
      type: 'tool_started',
      toolCallId: 'call-1',
      toolName: 'probe',
      arguments: { value: 'ok' },
    },
  ]);
  expect(events.filter((event) => event.type === 'command_message')).toEqual([
    expect.objectContaining({
      type: 'command_message',
      message: expect.objectContaining({
        callId: 'call-1',
        output: 'fixture result',
        status: 'completed',
      }),
    }),
  ]);
});

it('emits reasoning_delta events with accumulated fullText', async () => {
  const stream = makeStream([
    { data: { type: 'model', event: { choices: [{ delta: { reasoning_content: 'think' } }] } } },
    { data: { type: 'model', event: { choices: [{ delta: { reasoning_content: 'ing' } }] } } },
  ]);
  const acc = createStreamAccumulator();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    events.push(ev);
  }

  const reasoningEvents = events.filter((e) => e.type === 'reasoning_delta');
  expect(reasoningEvents.length).toBe(2);
  expect(reasoningEvents[0].delta).toBe('think');
  expect(reasoningEvents[1].fullText).toBe('thinking');
});

it('emits tool_started for function_call run_item_stream_event', async () => {
  const stream = makeStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId: 'call-1',
          name: 'shell',
          arguments: JSON.stringify({ command: 'ls' }),
        },
      },
    },
  ]);
  const acc = createStreamAccumulator();
  const opts = baseOpts();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, opts, baseDeps())) {
    events.push(ev);
  }

  const toolStarted = events.find((e) => e.type === 'tool_started');
  expect(toolStarted).toBeTruthy();
  expect(toolStarted.toolCallId).toBe('call-1');
  expect(toolStarted.toolName).toBe('shell');
  expect(toolStarted.arguments).toEqual({ command: 'ls' });
});

it('interprets wrapped, direct, and canonical tool calls identically while preserving hook inputs', async () => {
  const items = [
    {
      rawItem: {
        type: 'function_call',
        callId: 'call-wrapped',
        name: 'shell',
        arguments: JSON.stringify({ command: 'wrapped' }),
      },
    },
    {
      type: 'function_call',
      call_id: 'call-direct',
      name: 'shell',
      arguments: JSON.stringify({ command: 'direct' }),
    },
    {
      type: 'tool_call',
      callId: 'call-canonical',
      toolName: 'shell',
      arguments: { command: 'canonical' },
    },
  ];
  const seenRunItems: unknown[] = [];
  const seenCallItems: unknown[] = [];
  const opts: StreamProcessorOptions = {
    ...baseOpts(),
    onRunItem: (item) => seenRunItems.push(item),
    onFunctionCallItem: (item) => seenCallItems.push(item),
  };
  const events: any[] = [];

  for await (const event of processStreamEvents(
    makeStream(items.map((item) => ({ type: 'run_item_stream_event', item }))),
    createStreamAccumulator(),
    opts,
    baseDeps(),
  )) {
    events.push(event);
  }

  expect(events.filter(({ type }) => type === 'tool_started')).toEqual([
    { type: 'tool_started', toolCallId: 'call-wrapped', toolName: 'shell', arguments: { command: 'wrapped' } },
    { type: 'tool_started', toolCallId: 'call-direct', toolName: 'shell', arguments: { command: 'direct' } },
    {
      type: 'tool_started',
      toolCallId: 'call-canonical',
      toolName: 'shell',
      arguments: { command: 'canonical' },
    },
  ]);
  expect(seenRunItems).toEqual(items);
  expect(seenCallItems).toEqual(items);
  expect(seenCallItems[0]).toBe(items[0]);
  expect(seenCallItems[1]).toBe(items[1]);
  expect(seenCallItems[2]).toBe(items[2]);
});

it('dispatches normalized tool results while preserving each original result item', async () => {
  const items = [
    { rawItem: { type: 'function_call_result', callId: 'call-1', name: 'shell', output: 'one' } },
    { type: 'function_call_output', call_id: 'call-2', output: 'two' },
    { type: 'function_call_output_result', tool_call_id: 'call-3', output: 'three' },
    { type: 'tool_call_output_item', callId: 'call-4', output: 'four' },
    {
      type: 'tool_result',
      callId: 'call-5',
      toolName: 'shell',
      status: 'completed',
      output: 'five',
    },
  ];
  const seenResults: unknown[] = [];
  const opts: StreamProcessorOptions = {
    ...baseOpts(),
    onFunctionResultItem: (item) => seenResults.push(item),
  };

  for await (const _ of processStreamEvents(
    makeStream(items.map((item) => ({ type: 'run_item_stream_event', item }))),
    createStreamAccumulator(),
    opts,
    baseDeps(),
  )) {
    void _;
  }

  expect(seenResults).toEqual(items);
  items.forEach((item, index) => expect(seenResults[index]).toBe(item));
});

it('does not invent a tool_started identity when a provider function call has no call ID', async () => {
  const item = { rawItem: { type: 'function_call', name: 'shell', arguments: '{}' } };
  const seenCalls: unknown[] = [];
  const events: any[] = [];

  for await (const event of processStreamEvents(
    makeStream([{ type: 'run_item_stream_event', item }]),
    createStreamAccumulator(),
    { ...baseOpts(), onFunctionCallItem: (seen) => seenCalls.push(seen) },
    baseDeps(),
  )) {
    events.push(event);
  }

  expect(seenCalls).toEqual([item]);
  expect(events.some(({ type }) => type === 'tool_started')).toBe(false);
});

it('emits one tool_started for duplicate function_call events with the same callId', async () => {
  const functionCall = {
    type: 'run_item_stream_event',
    item: {
      rawItem: {
        type: 'function_call',
        callId: 'call-dup',
        name: 'shell',
        arguments: JSON.stringify({ command: 'npm test' }),
      },
    },
  };
  const stream = makeStream([functionCall, functionCall]);
  const acc = createStreamAccumulator();
  const opts = baseOpts();
  const events: any[] = [];

  for await (const ev of processStreamEvents(stream, acc, opts, baseDeps())) {
    events.push(ev);
  }

  const starts = events.filter((e) => e.type === 'tool_started');
  expect(starts.length).toBe(2);
  expect(starts[0].arguments).toEqual({ command: 'npm test' });
  expect(starts[1].arguments).toEqual({ command: 'npm test' });
});

it('emits tool_started even when the callId was already emitted by approval handling', async () => {
  const stream = makeStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId: 'call-approved',
          name: 'shell',
          arguments: JSON.stringify({ command: 'git status' }),
        },
      },
    },
  ]);
  const acc = createStreamAccumulator();
  const opts = baseOpts();
  const events: any[] = [];

  for await (const ev of processStreamEvents(stream, acc, opts, baseDeps())) {
    events.push(ev);
  }

  expect(events.some((e) => e.type === 'tool_started')).toBe(true);
});

it('invalid JSON arguments are deduped via emittedInvalidToolCallPackets', async () => {
  const events1 = [
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId: 'call-bad',
          name: 'shell',
          arguments: '{not-json',
        },
      },
    },
  ];

  let errorLogCount = 0;
  const trackingLogger: any = {
    info: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => {
      errorLogCount++;
    },
    getCorrelationId: () => 'trace-1',
  };
  const opts = baseOpts();
  const deps: StreamProcessorDeps = { logger: trackingLogger, sessionId: 's' };

  const acc1 = createStreamAccumulator();
  for await (const _ of processStreamEvents(makeStream(events1), acc1, opts, deps)) {
    void _;
  }
  // Second stream with same callId — should NOT log again
  const acc2 = createStreamAccumulator();
  for await (const _ of processStreamEvents(makeStream(events1), acc2, opts, deps)) {
    void _;
  }
  expect(errorLogCount).toBe(1);
  expect(opts.emittedInvalidToolCallPackets.has('call-bad')).toBe(true);
});

it('preserveExistingToolArgs=false clears the args map at start', async () => {
  const opts = baseOpts();
  opts.toolCallArgumentsById.set('old-call', { stale: true });
  opts.preserveExistingToolArgs = false;
  const stream = makeStream([]);
  const acc = createStreamAccumulator();
  for await (const _ of processStreamEvents(stream, acc, opts, baseDeps())) {
    void _;
  }
  expect(opts.toolCallArgumentsById.has('old-call')).toBe(false);
});

it('preserveExistingToolArgs=true keeps the args map intact', async () => {
  const opts = baseOpts();
  opts.toolCallArgumentsById.set('old-call', { kept: true });
  opts.preserveExistingToolArgs = true;
  const stream = makeStream([]);
  const acc = createStreamAccumulator();
  for await (const _ of processStreamEvents(stream, acc, opts, baseDeps())) {
    void _;
  }
  expect(opts.toolCallArgumentsById.get('old-call')).toEqual({ kept: true });
});

it('emits usage_update when stream event includes usage', async () => {
  const stream = makeStream([
    {
      data: {
        type: 'response.completed',
        response: {
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      },
    },
  ]);
  const acc = createStreamAccumulator();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    events.push(ev);
  }
  const usageEvents = events.filter((e) => e.type === 'usage_update');
  expect(usageEvents.length).toBe(1);
  expect(acc.latestUsage).toBeTruthy();
});

it('uses explicit adapted run usage before legacy runtime state usage', async () => {
  const source = makeStream([], {
    runUsage: { requests: 2, inputTokens: 31, outputTokens: 9, totalTokens: 40 },
    state: { usage: { requests: 2, inputTokens: 11, outputTokens: 7, totalTokens: 18 } },
    completed: Promise.resolve({ usage: { input_tokens: 3, output_tokens: 2 } }),
  });
  const stream = adaptAgentStream(source);
  const acc = createStreamAccumulator();

  for await (const _ of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    void _;
  }

  expect(acc.latestUsage).toMatchObject({ prompt_tokens: 31, completion_tokens: 9, total_tokens: 40 });
});

it('keeps authoritative application-loop totals, including cache writes, through event processing', async () => {
  let turn = 0;
  const loop = new ApplicationRunLoop({
    resolveModel: () => ({
      async *stream() {
        turn++;
        if (turn === 1) {
          yield { type: 'tool_call', id: 'usage-tool', name: 'usage_tool', arguments: '{}' };
          yield {
            type: 'completion',
            responseId: 'usage-1',
            output: [],
            usage: { inputTokens: 10, outputTokens: 2, cacheWriteTokens: 1 },
          };
          return;
        }
        yield {
          type: 'completion',
          responseId: 'usage-2',
          output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
          usage: { inputTokens: 20, outputTokens: 3, cacheWriteTokens: 2, cachedInputTokens: 5 },
        };
      },
    }),
  });
  const stream = loop.startStream(
    {
      name: 'usage',
      instructions: '',
      model: 'fixture',
      tools: [
        {
          name: 'usage_tool',
          description: 'fixture',
          parameters: { parse: () => ({}) },
          needsApproval: () => false,
          execute: () => 'ok',
          formatCommandMessage: () => [],
        },
      ],
    } as any,
    'measure',
  );
  const acc = createStreamAccumulator();
  for await (const _ of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    void _;
  }

  expect(stream.runUsage).toEqual({
    inputTokens: 30,
    outputTokens: 5,
    totalTokens: 38,
    cachedInputTokens: 5,
    cacheWriteTokens: 3,
  });
  expect(acc.latestUsage).toMatchObject({
    prompt_tokens: 30,
    completion_tokens: 5,
    total_tokens: 38,
    cache_read_tokens: 5,
    cache_creation_tokens: 3,
  });
});

it('end-of-stream usage harvest from completed promise', async () => {
  const stream = makeStream([], {
    completed: Promise.resolve({ usage: { input_tokens: 5, output_tokens: 7 } }),
  });
  const acc = createStreamAccumulator();
  for await (const _ of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    void _;
  }
  expect(acc.latestUsage).toBeTruthy();
});

it('end-of-stream usage preserves cache counters from streaming events when completion omits them', async () => {
  const stream = makeStream(
    [
      {
        type: 'raw_model_stream_event',
        data: {
          type: 'model',
          event: {
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              prompt_tokens_details: { cached_tokens: 60 },
            },
          },
        },
      },
    ],
    {
      completed: Promise.resolve({
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    },
  );
  const acc = createStreamAccumulator();
  for await (const _ of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    void _;
  }

  expect(acc.latestUsage).toEqual({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    cache_read_tokens: 60,
  });
});

it('throws AbortError if stream is cancelled', async () => {
  const stream = makeStream([], {
    completed: Promise.resolve(null),
    cancelled: true,
  });
  const acc = createStreamAccumulator();

  await expect(async () => {
    for await (const _ of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
      void _;
    }
  }).rejects.toMatchObject({ name: 'AbortError', message: 'The user aborted a request.' });
});

it('extracts codex rate limits from nested or flat structures in raw events', async () => {
  const nestedEvent = {
    type: 'codex.rate_limits',
    plan_type: 'plus',
    rate_limits: {
      allowed: true,
      limit_reached: false,
      primary: { used_percent: 11, window_minutes: 300, reset_after_seconds: 9697, reset_at: 1779703037 },
      secondary: { used_percent: 14, window_minutes: 10080, reset_after_seconds: 503937, reset_at: 1780197277 },
    },
  };

  const stream = makeStream([
    nestedEvent,
    // ApplicationRunLoop emits provider model events in this direct shape.
    { type: 'model', event: nestedEvent },
  ]);
  const acc = createStreamAccumulator();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    events.push(ev);
  }

  const rateLimitEvents = events.filter((e) => e.type === 'codex_rate_limits');
  expect(rateLimitEvents.length).toBe(2);
  const info = rateLimitEvents[0].rateLimits;
  expect(info.allowed).toBe(true);
  expect(info.limit_reached).toBe(false);
  expect(info.primary.used_percent).toBe(11);
  expect(info.secondary.used_percent).toBe(14);
});

it('emits tool_call_streaming_delta for Responses API argument deltas', async () => {
  const stream = makeStream([
    // Model starts a function_call
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: {
          type: 'response.output_item.added',
          output_index: 0,
          output_item: { type: 'function_call', name: 'shell', id: 'call-1' },
        },
      },
    },
    // Arguments stream in chunks
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: '{"command',
        },
      },
    },
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: '":"ls"}',
        },
      },
    },
  ]);
  const acc = createStreamAccumulator();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    events.push(ev);
  }

  const deltas = events.filter((e) => e.type === 'tool_call_streaming_delta');
  expect(deltas.length).toBe(2);
  // First delta: tool name from added event
  expect(deltas[0].toolName).toBe('shell');
  expect(deltas[0].argumentCharCount).toBe(9); // '{"command'.length
  // Second delta: name still available, count accumulated
  expect(deltas[1].toolName).toBe('shell');
  expect(deltas[1].argumentCharCount).toBe(16); // full args length
});

it('emits tool_call_streaming_delta for custom tool input deltas', async () => {
  const stream = makeStream([
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: {
          type: 'response.output_item.added',
          output_index: 0,
          output_item: { type: 'function_call', name: 'custom_tool', id: 'call-1' },
        },
      },
    },
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: {
          type: 'response.custom_tool_call_input.delta',
          output_index: 0,
          delta: '{"arg',
        },
      },
    },
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: {
          type: 'response.custom_tool_call_input.delta',
          output_index: 0,
          delta: '":1}',
        },
      },
    },
  ]);
  const acc = createStreamAccumulator();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    events.push(ev);
  }

  const deltas = events.filter((e) => e.type === 'tool_call_streaming_delta');
  expect(deltas.length).toBe(2);
  expect(deltas[0].toolName).toBe('custom_tool');
  expect(deltas[0].argumentCharCount).toBe(5); // '{"arg'.length
  expect(deltas[1].argumentCharCount).toBe(9);
});

it('emits tool_call_streaming_delta for MCP tool call argument deltas', async () => {
  const stream = makeStream([
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: {
          type: 'response.output_item.added',
          output_index: 0,
          output_item: { type: 'function_call', name: 'mcp_tool', id: 'call-1' },
        },
      },
    },
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: {
          type: 'response.mcp_call_arguments.delta',
          output_index: 0,
          delta: '{"param',
        },
      },
    },
  ]);
  const acc = createStreamAccumulator();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    events.push(ev);
  }

  const deltas = events.filter((e) => e.type === 'tool_call_streaming_delta');
  expect(deltas.length).toBe(1);
  expect(deltas[0].toolName).toBe('mcp_tool');
  expect(deltas[0].argumentCharCount).toBe(7);
});

it('emits tool_call_streaming_delta for legacy response.output_item.delta fallback', async () => {
  const stream = makeStream([
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'response.output_item.added',
        output_index: 0,
        output_item: { type: 'function_call', name: 'shell', id: 'call-1' },
      },
    },
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'response.output_item.delta',
        output_index: 0,
        delta: { arguments: '{"command' },
      },
    },
  ]);
  const acc = createStreamAccumulator();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    events.push(ev);
  }

  const deltas = events.filter((e) => e.type === 'tool_call_streaming_delta');
  expect(deltas.length).toBe(1);
  expect(deltas[0].toolName).toBe('shell');
  expect(deltas[0].argumentCharCount).toBe(9);
});

it('emits tool_call_streaming_delta for Chat Completions API tool_calls deltas', async () => {
  const stream = makeStream([
    // First chunk: tool call starts with name
    {
      data: {
        type: 'chunk',
        event: {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call-1', function: { name: 'shell', arguments: '' } }],
              },
            },
          ],
        },
      },
    },
    // Argument chunks
    {
      data: {
        type: 'chunk',
        event: {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"cmd' } }],
              },
            },
          ],
        },
      },
    },
    {
      data: {
        type: 'chunk',
        event: {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '":"pwd"}' } }],
              },
            },
          ],
        },
      },
    },
  ]);
  const acc = createStreamAccumulator();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    events.push(ev);
  }

  const deltas = events.filter((e) => e.type === 'tool_call_streaming_delta');
  // First chunk has empty arguments, so only 2 deltas emitted (chunks 2 and 3)
  expect(deltas.length).toBe(2);
  expect(deltas[0].toolName).toBe('shell');
  expect(deltas[0].argumentCharCount).toBe(5); // '{"cmd'.length
  expect(deltas[1].toolName).toBe('shell');
  expect(deltas[1].argumentCharCount).toBe(13); // full args length: '{"cmd' + '":"pwd"}'
});

it('tool_call_streaming_delta accumulates argument char count across deltas', async () => {
  const stream = makeStream([
    {
      data: {
        type: 'model',
        event: {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: 'aaa',
        },
      },
    },
    {
      data: {
        type: 'model',
        event: {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: 'bbb',
        },
      },
    },
    {
      data: {
        type: 'model',
        event: {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: 'ccc',
        },
      },
    },
  ]);
  const acc = createStreamAccumulator();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    events.push(ev);
  }

  const deltas = events.filter((e) => e.type === 'tool_call_streaming_delta');
  expect(deltas.length).toBe(3);
  expect(deltas[0].argumentCharCount).toBe(3);
  expect(deltas[1].argumentCharCount).toBe(6);
  expect(deltas[2].argumentCharCount).toBe(9);
});

it('tool_call_streaming_delta includes tool name from output_item.added when available', async () => {
  const stream = makeStream([
    {
      data: {
        type: 'model',
        event: {
          type: 'response.output_item.added',
          output_index: 0,
          output_item: { type: 'function_call', name: 'glob', id: 'call-1' },
        },
      },
    },
    {
      data: {
        type: 'model',
        event: {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: '{"pattern',
        },
      },
    },
  ]);
  const acc = createStreamAccumulator();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    events.push(ev);
  }

  const deltas = events.filter((e) => e.type === 'tool_call_streaming_delta');
  expect(deltas.length).toBe(1);
  expect(deltas[0].toolName).toBe('glob');
  expect(deltas[0].argumentCharCount).toBe(9); // '{"pattern'.length
});

it('tool_call_streaming_delta omits tool name when no output_item.added was seen', async () => {
  const stream = makeStream([
    {
      data: {
        type: 'model',
        event: {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: '{"x":1}',
        },
      },
    },
  ]);
  const acc = createStreamAccumulator();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    events.push(ev);
  }

  const deltas = events.filter((e) => e.type === 'tool_call_streaming_delta');
  expect(deltas.length).toBe(1);
  expect(deltas[0].toolName).toBe(undefined);
  expect(deltas[0].argumentCharCount).toBe(7);
});

it('tool_call_streaming_delta tracks argument char count independently per tool call index', async () => {
  const stream = makeStream([
    // Tool call 0 starts
    {
      data: {
        type: 'model',
        event: {
          type: 'response.output_item.added',
          output_index: 0,
          output_item: { type: 'function_call', name: 'shell', id: 'call-1' },
        },
      },
    },
    // Tool call 1 starts
    {
      data: {
        type: 'model',
        event: {
          type: 'response.output_item.added',
          output_index: 1,
          output_item: { type: 'function_call', name: 'glob', id: 'call-2' },
        },
      },
    },
    // Arguments for tool call 0
    {
      data: {
        type: 'model',
        event: {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: '{"cmd":"ls"}',
        },
      },
    },
    // Arguments for tool call 1
    {
      data: {
        type: 'model',
        event: {
          type: 'response.function_call_arguments.delta',
          output_index: 1,
          delta: '{"pattern":"*.ts"}',
        },
      },
    },
    // More arguments for tool call 0
    {
      data: {
        type: 'model',
        event: {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: ',"detailed":true',
        },
      },
    },
  ]);
  const acc = createStreamAccumulator();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    events.push(ev);
  }

  const deltas = events.filter((e) => e.type === 'tool_call_streaming_delta');
  expect(deltas.length).toBe(3);
  expect(deltas[0].toolName).toBe('shell');
  expect(deltas[0].argumentCharCount).toBe(12); // '{"cmd":"ls"}'.length
  expect(deltas[1].toolName).toBe('glob');
  expect(deltas[1].argumentCharCount).toBe(18); // '{"pattern":"*.ts"}'.length
  expect(deltas[2].toolName).toBe('shell');
  expect(deltas[2].argumentCharCount).toBe(28); // 12 + ',"detailed":true'.length
});

it('emits tool_call_streaming_delta for AI SDK tool-input start and delta events', async () => {
  const stream = makeStream([
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: {
          type: 'tool-input-start',
          id: 'call-1',
          toolName: 'shell',
        },
      },
    },
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: {
          type: 'tool-input-delta',
          id: 'call-1',
          delta: '{"command',
        },
      },
    },
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: {
          type: 'tool-input-delta',
          id: 'call-1',
          delta: '":"ls"}',
        },
      },
    },
  ]);
  const acc = createStreamAccumulator();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    events.push(ev);
  }

  const deltas = events.filter((e) => e.type === 'tool_call_streaming_delta');
  expect(deltas.length).toBe(2);
  expect(deltas[0].toolName).toBe('shell');
  expect(deltas[0].argumentCharCount).toBe(9); // '{"command'.length
  expect(deltas[1].toolName).toBe('shell');
  expect(deltas[1].argumentCharCount).toBe(16); // full args length
});

it('tool_call_streaming_delta resets argument char count when a new tool call starts on the same index/id', async () => {
  const stream = makeStream([
    // Responses API - tool call 0 (shell)
    {
      data: {
        type: 'model',
        event: {
          type: 'response.output_item.added',
          output_index: 0,
          output_item: { type: 'function_call', name: 'shell', id: 'call-1' },
        },
      },
    },
    {
      data: {
        type: 'model',
        event: {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: '{"cmd":"ls"}',
        },
      },
    },
    // Responses API - tool call 0 again (grep)
    {
      data: {
        type: 'model',
        event: {
          type: 'response.output_item.added',
          output_index: 0,
          output_item: { type: 'function_call', name: 'grep', id: 'call-2' },
        },
      },
    },
    {
      data: {
        type: 'model',
        event: {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: '{"pattern":"foo"}',
        },
      },
    },

    // Chat Completions API - tool call 0 (shell)
    {
      data: {
        type: 'chunk',
        event: {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call-3', function: { name: 'shell', arguments: '' } }],
              },
            },
          ],
        },
      },
    },
    {
      data: {
        type: 'chunk',
        event: {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"cmd"' } }],
              },
            },
          ],
        },
      },
    },
    // Chat Completions API - tool call 0 again (grep)
    {
      data: {
        type: 'chunk',
        event: {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call-4', function: { name: 'grep', arguments: '' } }],
              },
            },
          ],
        },
      },
    },
    {
      data: {
        type: 'chunk',
        event: {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"pat"' } }],
              },
            },
          ],
        },
      },
    },

    // AI SDK - tool call 1 (shell)
    {
      data: {
        type: 'model',
        event: {
          type: 'tool-input-start',
          id: 'call-5',
          toolName: 'shell',
        },
      },
    },
    {
      data: {
        type: 'model',
        event: {
          type: 'tool-input-delta',
          id: 'call-5',
          delta: '{"command',
        },
      },
    },
    // AI SDK - tool call 1 again (grep)
    {
      data: {
        type: 'model',
        event: {
          type: 'tool-input-start',
          id: 'call-5',
          toolName: 'grep',
        },
      },
    },
    {
      data: {
        type: 'model',
        event: {
          type: 'tool-input-delta',
          id: 'call-5',
          delta: '{"pattern',
        },
      },
    },
  ]);

  const acc = createStreamAccumulator();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    events.push(ev);
  }

  const deltas = events.filter((e) => e.type === 'tool_call_streaming_delta');
  expect(deltas.length).toBe(6);

  // Responses API verification
  expect(deltas[0].toolName).toBe('shell');
  expect(deltas[0].argumentCharCount).toBe(12); // '{"cmd":"ls"}'.length
  expect(deltas[1].toolName).toBe('grep');
  expect(deltas[1].argumentCharCount).toBe(17); // '{"pattern":"foo"}'.length (should be reset, not 29)

  // Chat Completions API verification
  expect(deltas[2].toolName).toBe('shell');
  expect(deltas[2].argumentCharCount).toBe(6); // '{"cmd"'.length
  expect(deltas[3].toolName).toBe('grep');
  expect(deltas[3].argumentCharCount).toBe(6); // '{"pat"'.length (should be reset, not 12)

  // AI SDK verification
  expect(deltas[4].toolName).toBe('shell');
  expect(deltas[4].argumentCharCount).toBe(9); // '{"command'.length
  expect(deltas[5].toolName).toBe('grep');
  expect(deltas[5].argumentCharCount).toBe(9); // '{"pattern'.length (should be reset, not 18)
});
