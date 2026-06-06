import test from 'ava';
import { LoggingService } from './logging-service.js';
import {
  createStreamAccumulator,
  processStreamEvents,
  type StreamProcessorOptions,
  type StreamProcessorDeps,
} from './stream-event-processor.js';
import type { AgentStream } from './agent-stream.js';

const logger = new LoggingService({ disableLogging: true });

const makeStream = (events: unknown[], extras: Partial<AgentStream> = {}): AgentStream => {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    completed: Promise.resolve(extras.completed ?? null),
    ...extras,
  } as AgentStream;
};

const baseOpts = (): StreamProcessorOptions => ({
  toolCallArgumentsById: new Map(),
  emittedInvalidToolCallPackets: new Set(),
  preserveExistingToolArgs: false,
});

const baseDeps = (): StreamProcessorDeps => ({ logger, sessionId: 'test-session' });

test('emits text_delta events with accumulated fullText', async (t) => {
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
  t.is(textEvents.length, 2);
  t.is(textEvents[0].delta, 'Hello');
  t.is(textEvents[0].fullText, 'Hello');
  t.is(textEvents[1].fullText, 'Hello world');
  t.is(acc.finalOutput, 'Hello world');
  t.is(acc.textDeltaCount, 2);
});

test('preserves newline between code fence language and first code line across text deltas', async (t) => {
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

  t.is(acc.finalOutput, '```typescript\nif (enabled) {\n  run();\n}\n```');
  t.true(events.some((e) => e.type === 'text_delta' && e.fullText === '```typescript\nif (enabled) {\n'));
});

test('emits reasoning_delta events with accumulated fullText', async (t) => {
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
  t.is(reasoningEvents.length, 2);
  t.is(reasoningEvents[0].delta, 'think');
  t.is(reasoningEvents[1].fullText, 'thinking');
});

test('emits tool_started for function_call run_item_stream_event', async (t) => {
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
  t.truthy(toolStarted);
  t.is(toolStarted.toolCallId, 'call-1');
  t.is(toolStarted.toolName, 'shell');
  t.deepEqual(toolStarted.arguments, { command: 'ls' });
});

test('emits one tool_started for duplicate function_call events with the same callId', async (t) => {
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
  t.is(starts.length, 2);
  t.deepEqual(starts[0].arguments, { command: 'npm test' });
  t.deepEqual(starts[1].arguments, { command: 'npm test' });
});

test('emits tool_started even when the callId was already emitted by approval handling', async (t) => {
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

  t.true(events.some((e) => e.type === 'tool_started'));
});

test('invalid JSON arguments are deduped via emittedInvalidToolCallPackets', async (t) => {
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
  t.is(errorLogCount, 1);
  t.true(opts.emittedInvalidToolCallPackets.has('call-bad'));
});

test('preserveExistingToolArgs=false clears the args map at start', async (t) => {
  const opts = baseOpts();
  opts.toolCallArgumentsById.set('old-call', { stale: true });
  opts.preserveExistingToolArgs = false;
  const stream = makeStream([]);
  const acc = createStreamAccumulator();
  for await (const _ of processStreamEvents(stream, acc, opts, baseDeps())) {
    void _;
  }
  t.false(opts.toolCallArgumentsById.has('old-call'));
});

test('preserveExistingToolArgs=true keeps the args map intact', async (t) => {
  const opts = baseOpts();
  opts.toolCallArgumentsById.set('old-call', { kept: true });
  opts.preserveExistingToolArgs = true;
  const stream = makeStream([]);
  const acc = createStreamAccumulator();
  for await (const _ of processStreamEvents(stream, acc, opts, baseDeps())) {
    void _;
  }
  t.deepEqual(opts.toolCallArgumentsById.get('old-call'), { kept: true });
});

test('emits usage_update when stream event includes usage', async (t) => {
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
  t.is(usageEvents.length, 1);
  t.truthy(acc.latestUsage);
});

test('end-of-stream usage harvest from completed promise', async (t) => {
  const stream = makeStream([], {
    completed: Promise.resolve({ usage: { input_tokens: 5, output_tokens: 7 } }),
  });
  const acc = createStreamAccumulator();
  for await (const _ of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    void _;
  }
  t.truthy(acc.latestUsage);
});

test('end-of-stream usage preserves cache counters from streaming events when completion omits them', async (t) => {
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

  t.deepEqual(acc.latestUsage, {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    cache_read_tokens: 60,
  });
});

test('throws AbortError if stream is cancelled', async (t) => {
  const stream = makeStream([], {
    completed: Promise.resolve(null),
    cancelled: true,
  });
  const acc = createStreamAccumulator();
  await t.throwsAsync(
    async () => {
      for await (const _ of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
        void _;
      }
    },
    { name: 'AbortError', message: 'The user aborted a request.' },
  );
});

test('extracts codex rate limits from nested or flat structures in raw events', async (t) => {
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

  const stream = makeStream([nestedEvent]);
  const acc = createStreamAccumulator();
  const events: any[] = [];
  for await (const ev of processStreamEvents(stream, acc, baseOpts(), baseDeps())) {
    events.push(ev);
  }

  const rateLimitEvents = events.filter((e) => e.type === 'codex_rate_limits');
  t.is(rateLimitEvents.length, 1);
  const info = rateLimitEvents[0].rateLimits;
  t.is(info.allowed, true);
  t.is(info.limit_reached, false);
  t.is(info.primary.used_percent, 11);
  t.is(info.secondary.used_percent, 14);
});

test('emits tool_call_streaming_delta for Responses API argument deltas', async (t) => {
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
  t.is(deltas.length, 2);
  // First delta: tool name from added event
  t.is(deltas[0].toolName, 'shell');
  t.is(deltas[0].argumentCharCount, 9); // '{"command'.length
  // Second delta: name still available, count accumulated
  t.is(deltas[1].toolName, 'shell');
  t.is(deltas[1].argumentCharCount, 16); // full args length
});

test('emits tool_call_streaming_delta for custom tool input deltas', async (t) => {
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
  t.is(deltas.length, 2);
  t.is(deltas[0].toolName, 'custom_tool');
  t.is(deltas[0].argumentCharCount, 5); // '{"arg'.length
  t.is(deltas[1].argumentCharCount, 9);
});

test('emits tool_call_streaming_delta for MCP tool call argument deltas', async (t) => {
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
  t.is(deltas.length, 1);
  t.is(deltas[0].toolName, 'mcp_tool');
  t.is(deltas[0].argumentCharCount, 7);
});

test('emits tool_call_streaming_delta for legacy response.output_item.delta fallback', async (t) => {
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
  t.is(deltas.length, 1);
  t.is(deltas[0].toolName, 'shell');
  t.is(deltas[0].argumentCharCount, 9);
});

test('emits tool_call_streaming_delta for Chat Completions API tool_calls deltas', async (t) => {
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
  t.is(deltas.length, 2);
  t.is(deltas[0].toolName, 'shell');
  t.is(deltas[0].argumentCharCount, 5); // '{"cmd'.length
  t.is(deltas[1].toolName, 'shell');
  t.is(deltas[1].argumentCharCount, 13); // full args length: '{"cmd' + '":"pwd"}'
});

test('tool_call_streaming_delta accumulates argument char count across deltas', async (t) => {
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
  t.is(deltas.length, 3);
  t.is(deltas[0].argumentCharCount, 3);
  t.is(deltas[1].argumentCharCount, 6);
  t.is(deltas[2].argumentCharCount, 9);
});

test('tool_call_streaming_delta includes tool name from output_item.added when available', async (t) => {
  const stream = makeStream([
    {
      data: {
        type: 'model',
        event: {
          type: 'response.output_item.added',
          output_index: 0,
          output_item: { type: 'function_call', name: 'find_files', id: 'call-1' },
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
  t.is(deltas.length, 1);
  t.is(deltas[0].toolName, 'find_files');
  t.is(deltas[0].argumentCharCount, 9); // '{"pattern'.length
});

test('tool_call_streaming_delta omits tool name when no output_item.added was seen', async (t) => {
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
  t.is(deltas.length, 1);
  t.is(deltas[0].toolName, undefined);
  t.is(deltas[0].argumentCharCount, 7);
});

test('tool_call_streaming_delta tracks argument char count independently per tool call index', async (t) => {
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
          output_item: { type: 'function_call', name: 'find_files', id: 'call-2' },
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
  t.is(deltas.length, 3);
  t.is(deltas[0].toolName, 'shell');
  t.is(deltas[0].argumentCharCount, 12); // '{"cmd":"ls"}'.length
  t.is(deltas[1].toolName, 'find_files');
  t.is(deltas[1].argumentCharCount, 18); // '{"pattern":"*.ts"}'.length
  t.is(deltas[2].toolName, 'shell');
  t.is(deltas[2].argumentCharCount, 28); // 12 + ',"detailed":true'.length
});

test('emits tool_call_streaming_delta for AI SDK tool-input start and delta events', async (t) => {
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
  t.is(deltas.length, 2);
  t.is(deltas[0].toolName, 'shell');
  t.is(deltas[0].argumentCharCount, 9); // '{"command'.length
  t.is(deltas[1].toolName, 'shell');
  t.is(deltas[1].argumentCharCount, 16); // full args length
});
