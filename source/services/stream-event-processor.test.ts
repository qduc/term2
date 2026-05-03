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
