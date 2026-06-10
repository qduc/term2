import test from 'ava';
import { LoggingService } from './logging-service.js';
import { SessionStreamProcessor } from './session-stream-processor.js';
import { ConversationStore } from './conversation-store.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { ConversationLogger } from './conversation-logger.js';
import { ProviderContinuity } from './provider-continuity.js';
import type { AgentStream } from './agent-stream.js';
import type { ConversationEvent } from './conversation-events.js';
import { GenerationGuard } from './generation-guard.js';

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

test('SessionStreamProcessor.process() streams events and updates toolTracker', async (t) => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);

  let loggedEvents: any[] = [];
  const conversationLogger = {
    hasSink: () => true,
    log: (event: any) => loggedEvents.push(event),
  } as unknown as ConversationLogger;

  const providerContinuity = new ProviderContinuity();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard: new GenerationGuard(),
  });

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
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call_result',
          callId: 'call-1',
          name: 'shell',
          output: 'file1.txt',
        },
      },
    },
  ]);

  const events: ConversationEvent[] = [];
  const generator = processor.process(stream, {
    gen: 1,
    source: 'continueRunStream',
    preserveExistingToolArgs: false,
  });

  let acc: any = null;
  while (true) {
    const result = await generator.next();
    if (result.done) {
      acc = result.value;
      break;
    } else {
      events.push(result.value);
    }
  }

  t.truthy(acc);
  t.true(events.some((e) => e.type === 'tool_started'));
  t.is(toolTracker.argumentsById.get('call-1'), JSON.stringify({ command: 'ls' }));
  t.is(loggedEvents.length, 1);
  t.is(loggedEvents[0].type, 'tool_result');
  t.is(loggedEvents[0].callId, 'call-1');
  t.is(loggedEvents[0].output, 'file1.txt');
});

test('SessionStreamProcessor.process() does not log tool results for startStream source', async (t) => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);

  let loggedEvents: any[] = [];
  const conversationLogger = {
    hasSink: () => true,
    log: (event: any) => loggedEvents.push(event),
  } as unknown as ConversationLogger;

  const providerContinuity = new ProviderContinuity();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard: new GenerationGuard(),
  });

  const stream = makeStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call_result',
          callId: 'call-1',
          name: 'shell',
          output: 'file1.txt',
        },
      },
    },
  ]);

  const events: ConversationEvent[] = [];
  const generator = processor.process(stream, {
    gen: 1,
    source: 'startStream',
    preserveExistingToolArgs: false,
  });

  for await (const event of generator) {
    events.push(event);
  }

  t.is(loggedEvents.length, 0); // Should not log for startStream
});

test('SessionStreamProcessor.finalize() updates providerContinuity previousResponseId', async (t) => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const conversationLogger = {} as unknown as ConversationLogger;
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
  });

  const token = generationGuard.capture();
  const stream = makeStream([], {
    interruptions: [],
    lastResponseId: 'resp-123',
  });

  const result = processor.finalize(stream, token, 'delta', 'startStream');

  t.deepEqual(result, { kind: 'committed' });
  t.is(providerContinuity.previousResponseId, 'resp-123');
});

test('SessionStreamProcessor.finalize() prefers full replay history when full-history output only contains tool results', (t) => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const conversationLogger = {} as unknown as ConversationLogger;
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
  });

  const fullHistory = [
    { role: 'user', type: 'message', content: 'Inspect the logs' },
    { type: 'function_call', callId: 'call-read', name: 'read_file', arguments: '{}' },
    { type: 'function_call_output', callId: 'call-read', output: 'log contents' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'I found the problem.' }],
    },
  ];

  const token = generationGuard.capture();
  const stream = makeStream([], {
    interruptions: [],
    lastResponseId: 'resp-123',
  });
  (stream as any).history = fullHistory;
  (stream as any).output = [{ type: 'function_call_output', callId: 'call-read', output: 'log contents' }];
  (stream as any).newItems = [];

  const result = processor.finalize(stream, token, 'full_history', 'startStream');

  t.deepEqual(result, { kind: 'committed' });
  t.deepEqual(conversationStore.getHistory(), fullHistory);
});

test('SessionStreamProcessor.finalize() - stale finalization mutates neither continuity nor history and returns stale', (t) => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const conversationLogger = {} as unknown as ConversationLogger;
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
  });

  const staleToken = generationGuard.capture();
  generationGuard.invalidate(); // invalidates staleToken

  const stream = makeStream([], {
    interruptions: [],
    lastResponseId: 'resp-123',
  });
  (stream as any).output = [{ role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'hello' }] }];

  const result = processor.finalize(stream, staleToken, 'delta', 'startStream');

  t.deepEqual(result, { kind: 'stale' });
  t.is(providerContinuity.previousResponseId, null);
  t.is(conversationStore.getHistory().length, 0);
});

test('SessionStreamProcessor.finalize() - interrupted stream returns partial, updates continuity, but does not commit terminal history', (t) => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const conversationLogger = {} as unknown as ConversationLogger;
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
  });

  const token = generationGuard.capture();

  const stream = makeStream([], {
    interruptions: [{ type: 'tool_approval_item' }] as any,
    lastResponseId: 'resp-123',
  });
  (stream as any).output = [{ role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'hello' }] }];

  const result = processor.finalize(stream, token, 'delta', 'startStream');

  t.deepEqual(result, { kind: 'partial' });
  t.is(providerContinuity.previousResponseId, 'resp-123');
  t.is(conversationStore.getHistory().length, 0); // Should not commit history
});
