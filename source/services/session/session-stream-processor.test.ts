import test from 'ava';
import { LoggingService } from '../logging/logging-service.js';
import { SessionStreamProcessor } from './session-stream-processor.js';
import { ConversationStore } from '../conversation/conversation-store.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { ConversationLogger } from '../logging/conversation-logger.js';
import { ProviderContinuity } from '../provider-continuity.js';
import type { AgentStream } from '../agent-stream.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { GenerationGuard } from '../generation-guard.js';

const logger = new LoggingService({ disableLogging: true });

const makeStream = (events: unknown[], extras: Partial<AgentStream> = {}): AgentStream => {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    completed: Promise.resolve(extras.completed ?? null),
    ...extras,
  } as unknown as AgentStream;
};

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
  const generationGuard = new GenerationGuard();
  const token = generationGuard.capture();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
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
    gen: token,
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

test('SessionStreamProcessor.process() preserves reasoning before recovered tool call history', async (t) => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);

  const loggedEvents: any[] = [];
  const conversationLogger = {
    hasSink: () => true,
    log: (event: any) => loggedEvents.push(event),
  } as unknown as ConversationLogger;

  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();
  const token = generationGuard.capture();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
  });

  const stream = makeStream([
    {
      type: 'raw_model_stream_event',
      data: { type: 'model', event: { choices: [{ delta: { reasoning_content: 'I should inspect.' } }] } },
    },
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId: 'call-1',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'package.json' }),
        },
      },
    },
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call_result',
          callId: 'call-1',
          name: 'read_file',
          output: 'contents',
        },
      },
    },
  ]);

  const events: ConversationEvent[] = [];
  const generator = processor.process(stream, {
    gen: token,
    source: 'continueRunStream',
    preserveExistingToolArgs: false,
  });
  for (;;) {
    const result = await generator.next();
    if (result.done) break;
    events.push(result.value);
  }

  t.true(events.some((event) => event.type === 'reasoning_delta'));
  t.deepEqual(
    events.map((event) => event.type),
    ['reasoning_delta', 'tool_started', 'command_message'],
  );
  const historyItems = toolTracker.export()[0].historyItems as Array<Record<string, any>>;
  t.deepEqual(
    historyItems.map((item) => item.type),
    ['reasoning', 'function_call', 'function_call_result'],
  );
  t.is(historyItems[0].content[0].text, 'I should inspect.');
  t.deepEqual(loggedEvents[0].historyItems, historyItems);
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
  const generationGuard = new GenerationGuard();
  const token = generationGuard.capture();

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
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
    gen: token,
    source: 'startStream',
    preserveExistingToolArgs: false,
  });

  for await (const event of generator) {
    events.push(event);
  }

  t.is(loggedEvents.length, 0); // Should not log for startStream
});

test('SessionStreamProcessor.process() stops pulling stale stream work after generation invalidation', async (t) => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);

  const loggedEvents: any[] = [];
  const conversationLogger = {
    hasSink: () => true,
    log: (event: any) => loggedEvents.push(event),
  } as unknown as ConversationLogger;

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

  const generator = processor.process(stream, {
    gen: token,
    source: 'continueRunStream',
    preserveExistingToolArgs: false,
  });

  const first = await generator.next();
  t.false(first.done);
  t.true('type' in first.value);
  t.is((first.value as ConversationEvent).type, 'tool_started');

  generationGuard.invalidate();

  const second = await generator.next();
  t.true(second.done);
  t.is(toolTracker.export()[0]?.status, 'started');
  t.is(loggedEvents.length, 0);
});

test('SessionStreamProcessor.process() ignores a stale tool result that arrives while next() is blocked', async (t) => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);

  const loggedEvents: any[] = [];
  const conversationLogger = {
    hasSink: () => true,
    log: (event: any) => loggedEvents.push(event),
  } as unknown as ConversationLogger;

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
  const releaseSecond = createDeferred<void>();
  let secondPullStarted = false;

  const stream = {
    [Symbol.asyncIterator]: async function* () {
      yield {
        type: 'run_item_stream_event',
        item: {
          rawItem: {
            type: 'function_call',
            callId: 'call-1',
            name: 'shell',
            arguments: JSON.stringify({ command: 'ls' }),
          },
        },
      };

      secondPullStarted = true;
      await releaseSecond.promise;
      yield {
        type: 'run_item_stream_event',
        item: {
          rawItem: {
            type: 'function_call_result',
            callId: 'call-1',
            name: 'shell',
            output: 'file1.txt',
          },
        },
      };
    },
    completed: Promise.resolve(null),
  } as unknown as AgentStream;

  const generator = processor.process(stream, {
    gen: token,
    source: 'continueRunStream',
    preserveExistingToolArgs: false,
  });

  const first = await generator.next();
  t.false(first.done);
  t.true('type' in first.value);
  t.is((first.value as ConversationEvent).type, 'tool_started');

  const secondPromise = generator.next();
  await Promise.resolve();
  t.true(secondPullStarted);

  generationGuard.invalidate();
  releaseSecond.resolve();

  const second = await secondPromise;
  t.true(second.done);
  const ledger = toolTracker.export();
  t.is(ledger.length, 1);
  t.is(ledger[0]?.callId, 'call-1');
  t.is(ledger[0]?.status, 'started');
  t.is(ledger[0]?.output, undefined);
  t.deepEqual(ledger[0]?.historyItems, [
    {
      type: 'function_call',
      callId: 'call-1',
      name: 'shell',
      arguments: JSON.stringify({ command: 'ls' }),
    },
  ]);
  t.is(loggedEvents.length, 0);
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

test('SessionStreamProcessor.process() feeds every raw run item into the journal', async (t) => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const conversationLogger = { hasSink: () => false } as unknown as ConversationLogger;
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();
  const token = generationGuard.capture();

  const journalItems: unknown[] = [];
  const journal = {
    recordRunItem: (item: unknown) => {
      journalItems.push(item);
    },
  } as any;

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    getJournal: () => journal,
  });

  const stream = makeStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{}' },
      },
    },
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: { type: 'function_call_result', callId: 'call-1', name: 'shell', output: 'ok' },
      },
    },
  ]);

  for await (const _ of processor.process(stream, {
    gen: token,
    source: 'continueRunStream',
    preserveExistingToolArgs: false,
  })) {
    // drain
  }

  // Both raw run items should have been fed to the journal.
  t.is(journalItems.length, 2);
  t.is((journalItems[0] as any).rawItem.type, 'function_call');
  t.is((journalItems[1] as any).rawItem.type, 'function_call_result');
});

test('SessionStreamProcessor.process() drops journal writes after generation invalidation', async (t) => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const conversationLogger = { hasSink: () => false } as unknown as ConversationLogger;
  const providerContinuity = new ProviderContinuity();
  const generationGuard = new GenerationGuard();

  const journalItems: unknown[] = [];
  const journal = {
    recordRunItem: (item: unknown) => {
      journalItems.push(item);
    },
  } as any;

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    providerContinuity,
    generationGuard,
    getJournal: () => journal,
  });

  const token = generationGuard.capture();
  const stream = makeStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{}' },
      },
    },
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: { type: 'function_call_result', callId: 'call-1', name: 'shell', output: 'ok' },
      },
    },
  ]);

  const generator = processor.process(stream, {
    gen: token,
    source: 'continueRunStream',
    preserveExistingToolArgs: false,
  });

  // Drain the first event (tool_started).
  await generator.next();
  // Invalidate the generation so subsequent journal writes are dropped.
  generationGuard.invalidate();
  // Drain the rest. The second run_item_stream_event is processed after
  // invalidation and must not be fed to the journal.
  while (true) {
    const r = await generator.next();
    if (r.done) break;
  }

  // Only the first raw item was committed to the journal; the second was dropped.
  t.is(journalItems.length, 1);
  t.is((journalItems[0] as any).rawItem.type, 'function_call');
});
