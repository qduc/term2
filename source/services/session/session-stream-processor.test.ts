import { it, expect } from 'vitest';
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

it('SessionStreamProcessor.process() streams events and updates toolTracker', async () => {
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

  expect(acc).toBeTruthy();
  expect(events.some((e) => e.type === 'tool_started')).toBe(true);
  expect(toolTracker.argumentsById.get('call-1')).toBe(JSON.stringify({ command: 'ls' }));
  expect(loggedEvents.length).toBe(1);
  expect(loggedEvents[0].type).toBe('tool_result');
  expect(loggedEvents[0].callId).toBe('call-1');
  expect(loggedEvents[0].output).toBe('file1.txt');
});

it('SessionStreamProcessor.process() preserves reasoning before recovered tool call history', async () => {
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

  expect(events.some((event) => event.type === 'reasoning_delta')).toBe(true);
  expect(events.map((event) => event.type)).toEqual(['reasoning_delta', 'tool_started', 'command_message']);
  const historyItems = toolTracker.export()[0].historyItems as Array<Record<string, any>>;
  expect(historyItems.map((item) => item.type)).toEqual(['reasoning', 'function_call', 'function_call_result']);
  expect(historyItems[0].content[0].text).toBe('I should inspect.');
  expect(loggedEvents[0].historyItems).toEqual(historyItems);
});

it('SessionStreamProcessor.process() does not log tool results for startStream source', async () => {
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

  expect(loggedEvents.length).toBe(0); // Should not log for startStream
});

it('SessionStreamProcessor.process() stops pulling stale stream work after generation invalidation', async () => {
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
  expect(first.done).toBe(false);
  expect('type' in first.value).toBe(true);
  expect((first.value as ConversationEvent).type).toBe('tool_started');

  generationGuard.invalidate();

  const second = await generator.next();
  expect(second.done).toBe(true);
  expect(toolTracker.export()[0]?.status).toBe('started');
  expect(loggedEvents.length).toBe(0);
});

it('SessionStreamProcessor.process() ignores a stale tool result that arrives while next() is blocked', async () => {
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
  expect(first.done).toBe(false);
  expect('type' in first.value).toBe(true);
  expect((first.value as ConversationEvent).type).toBe('tool_started');

  const secondPromise = generator.next();
  await Promise.resolve();
  expect(secondPullStarted).toBe(true);

  generationGuard.invalidate();
  releaseSecond.resolve();

  const second = await secondPromise;
  expect(second.done).toBe(true);
  const ledger = toolTracker.export();
  expect(ledger.length).toBe(1);
  expect(ledger[0]?.callId).toBe('call-1');
  expect(ledger[0]?.status).toBe('started');
  expect(ledger[0]?.output).toBeUndefined();
  expect(ledger[0]?.historyItems).toEqual([
    {
      type: 'function_call',
      callId: 'call-1',
      name: 'shell',
      arguments: JSON.stringify({ command: 'ls' }),
    },
  ]);
  expect(loggedEvents.length).toBe(0);
});

it('SessionStreamProcessor.finalize() updates providerContinuity previousResponseId', async () => {
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

  expect(result).toEqual({ kind: 'committed' });
  expect(providerContinuity.previousResponseId).toBe('resp-123');
});

it('SessionStreamProcessor.finalize() prefers full replay history when full-history output only contains tool results', () => {
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

  expect(result).toEqual({ kind: 'committed' });
  expect(conversationStore.getHistory()).toEqual(fullHistory);
});

it('SessionStreamProcessor.finalize() - stale finalization mutates neither continuity nor history and returns stale', () => {
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

  expect(result).toEqual({ kind: 'stale' });
  expect(providerContinuity.previousResponseId).toBeNull();
  expect(conversationStore.getHistory().length).toBe(0);
});

it('SessionStreamProcessor.finalize() - interrupted stream returns partial, updates continuity, but does not commit terminal history', () => {
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

  expect(result).toEqual({ kind: 'partial' });
  expect(providerContinuity.previousResponseId).toBe('resp-123');
  expect(conversationStore.getHistory().length).toBe(0); // Should not commit history
});

it('SessionStreamProcessor.process() feeds every raw run item into the journal', async () => {
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
  expect(journalItems.length).toBe(2);
  expect((journalItems[0] as any).rawItem.type).toBe('function_call');
  expect((journalItems[1] as any).rawItem.type).toBe('function_call_result');
});

it('SessionStreamProcessor.process() drops journal writes after generation invalidation', async () => {
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
  expect(journalItems.length).toBe(1);
  expect((journalItems[0] as any).rawItem.type).toBe('function_call');
});
