import test from 'ava';
import { LoggingService } from './logging-service.js';
import { SessionStreamProcessor } from './session-stream-processor.js';
import { ConversationStore } from './conversation-store.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { ConversationLogger } from './conversation-logger.js';
import { SessionRetryOrchestrator } from './session-retry-orchestrator.js';
import { SessionStateController } from './session-state-controller.js';
import { SessionInputPlanner } from './session-input-planner.js';
import type { AgentStream } from './agent-stream.js';
import type { ConversationEvent } from './conversation-events.js';

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

  const retryOrchestrator = {} as unknown as SessionRetryOrchestrator;
  const state = {} as unknown as SessionStateController;
  const inputPlanner = {} as unknown as SessionInputPlanner;

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    retryOrchestrator,
    state,
    inputPlanner,
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

  const retryOrchestrator = {} as unknown as SessionRetryOrchestrator;
  const state = {} as unknown as SessionStateController;
  const inputPlanner = {} as unknown as SessionInputPlanner;

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    retryOrchestrator,
    state,
    inputPlanner,
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

test('SessionStreamProcessor.finalize() updates state and planner previousResponseId', async (t) => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const conversationLogger = {} as unknown as ConversationLogger;

  let isCurrentGeneration = true;
  const retryOrchestrator = {
    isCurrentGeneration: () => isCurrentGeneration,
    inputSurgeKindState: 'delta',
  } as unknown as SessionRetryOrchestrator;

  const state = {
    previousResponseId: null as string | null,
  } as unknown as SessionStateController;

  const inputPlanner = {
    previousResponseId: null as string | null,
  } as unknown as SessionInputPlanner;

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    retryOrchestrator,
    state,
    inputPlanner,
  });

  const stream = makeStream([], {
    interruptions: [],
    lastResponseId: 'resp-123',
  });

  processor.finalize(stream, 1, 'startStream');

  t.is(state.previousResponseId, 'resp-123');
  t.is(inputPlanner.previousResponseId, 'resp-123');
});

test('SessionStreamProcessor.finalize() prefers full replay history when full-history output only contains tool results', (t) => {
  const conversationStore = new ConversationStore();
  const toolTracker = new SessionToolTracker(conversationStore);
  const conversationLogger = {} as unknown as ConversationLogger;

  const retryOrchestrator = {
    isCurrentGeneration: () => true,
    inputSurgeKindState: 'full_history',
  } as unknown as SessionRetryOrchestrator;

  const state = {
    previousResponseId: null as string | null,
  } as unknown as SessionStateController;

  const inputPlanner = {
    previousResponseId: null as string | null,
  } as unknown as SessionInputPlanner;

  const processor = new SessionStreamProcessor({
    logger,
    sessionId: 'test-session',
    toolTracker,
    conversationStore,
    conversationLogger,
    retryOrchestrator,
    state,
    inputPlanner,
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

  const stream = makeStream([], {
    interruptions: [],
    lastResponseId: 'resp-123',
  });
  (stream as any).history = fullHistory;
  (stream as any).output = [{ type: 'function_call_output', callId: 'call-read', output: 'log contents' }];
  (stream as any).newItems = [];

  processor.finalize(stream, 1, 'startStream');

  t.deepEqual(conversationStore.getHistory(), fullHistory);
});
