import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { LogEvent } from '../logging/conversation-log-events.js';
import { createConversationSession } from './session-composition.js';

const createMockLogger = () => {
  const events: Array<{
    level: 'info' | 'warn' | 'error' | 'debug';
    meta: Record<string, unknown> | undefined;
  }> = [];
  return {
    events,
    logger: {
      info: (_message: string, meta?: any) => {
        events.push({ level: 'info', meta });
      },
      warn: (_message: string, meta?: any) => {
        events.push({ level: 'warn', meta });
      },
      error: (_message: string, meta?: any) => {
        events.push({ level: 'error', meta });
      },
      debug: (_message: string, meta?: any) => {
        events.push({ level: 'debug', meta });
      },
      security: () => {},
      setCorrelationId: () => {},
      getCorrelationId: () => 'trace-test-1',
      clearCorrelationId: () => {},
    },
  };
};

const sessionContextService = {
  runWithContext: (_context: any, fn: () => any) => fn(),
  getContext: () => null,
};

class MockStream {
  events: any[];
  completed: Promise<void>;
  lastResponseId: string;
  interruptions: any[];
  state: any;
  newItems: any[];
  history: any[];
  finalOutput: string;

  constructor(events: any[]) {
    this.events = events;
    this.completed = Promise.resolve();
    this.lastResponseId = 'resp_test';
    this.interruptions = [];
    this.state = {};
    this.newItems = [];
    this.history = [];
    this.finalOutput = '';
  }

  async *[Symbol.asyncIterator]() {
    for (const event of this.events) {
      yield event;
    }
  }
}

it('run() emits tool_started with parsed arguments when function_call arguments are JSON string', async () => {
  const stream = new MockStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId: 'call-1',
          name: 'shell',
          arguments: JSON.stringify({ command: 'echo hi' }),
        },
      },
    },
  ]);

  const mockClient: any = {
    async startStream() {
      return stream;
    },
  };

  const { logger } = createMockLogger();
  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  const emitted: ConversationEvent[] = [];
  for await (const ev of turnCoordinator.start('hi')) {
    emitted.push(ev);
  }

  const firstEvent = emitted[0] as Extract<ConversationEvent, { type: 'tool_started' }> & {
    arguments: { command: string };
  };
  expect(firstEvent.type).toBe('tool_started');
  expect(typeof firstEvent.arguments === 'object').toBe(true);
  expect(firstEvent.arguments.command).toBe('echo hi');
});

it('run() emits one diagnostic packet when tool arguments contain malformed JSON', async () => {
  const stream = new MockStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId: 'call-malformed',
          name: 'shell',
          arguments: '{"command":"echo hi"',
        },
      },
    },
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId: 'call-malformed',
          name: 'shell',
          arguments: '{"command":"echo hi"',
        },
      },
    },
  ]);

  const mockClient: any = {
    async startStream() {
      return stream;
    },
  };

  const { logger, events } = createMockLogger();
  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  for await (const _ev of turnCoordinator.start('hi')) {
    // consume stream
  }

  const packets = events.filter(
    (entry) => entry.level === 'error' && entry.meta?.eventType === 'tool_call.parse_failed',
  );
  expect(packets.length).toBe(1);
  const packet = packets[0]!;
  const packetMeta = packet.meta as {
    errorCode: string;
    traceId: string;
    validationErrors: unknown[];
  };
  expect(packetMeta.errorCode).toBe('INVALID_TOOL_CALL_FORMAT');
  expect(packetMeta.traceId).toBe('trace-test-1');
  expect(Array.isArray(packetMeta.validationErrors)).toBe(true);
});

it('approval continuation does not persist duplicate tool_started when SDK replays function_call', async () => {
  const callId = 'call-approval-replay';
  const args = JSON.stringify({ command: 'git status' });
  const state = { approve: () => undefined };
  const interruption = { name: 'shell', callId, arguments: args };
  const initialStream = new MockStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId,
          name: 'shell',
          arguments: args,
        },
      },
    },
  ]);
  initialStream.interruptions = [interruption];
  initialStream.state = state;

  const continuationStream = new MockStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId,
          name: 'shell',
          arguments: args,
        },
      },
    },
  ]);
  continuationStream.finalOutput = 'done';

  const mockClient: any = {
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      return continuationStream;
    },
  };

  const { logger } = createMockLogger();
  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger, sessionContextService },
  });
  const { terminalAdapter, conversationLogger } = bundle;
  const persisted: LogEvent[] = [];
  conversationLogger.setLogSink((event) => {
    persisted.push(event);
  });

  await terminalAdapter.sendMessage('hi');
  await terminalAdapter.handleApprovalDecision('y');

  const starts = persisted.filter(
    (event): event is Extract<LogEvent, { type: 'tool_started' }> =>
      event.type === 'tool_started' && event.toolCallId === callId,
  );
  expect(starts.length).toBe(1);
  expect(starts[0]!.arguments).toEqual({ command: 'git status' });
});

it('run() emits one tool_started for duplicate function_call events with the same callId', async () => {
  const stream = new MockStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId: 'call-dup',
          name: 'shell',
          arguments: JSON.stringify({ command: 'npm test' }),
        },
      },
    },
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId: 'call-dup',
          name: 'shell',
          arguments: JSON.stringify({ command: 'npm test' }),
        },
      },
    },
  ]);
  stream.finalOutput = 'done';

  const mockClient: any = {
    async startStream() {
      return stream;
    },
  };

  const { logger } = createMockLogger();
  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  const emitted: ConversationEvent[] = [];
  for await (const ev of turnCoordinator.start('hi')) {
    emitted.push(ev);
  }

  const starts = emitted.filter(
    (event): event is Extract<ConversationEvent, { type: 'tool_started' }> =>
      event.type === 'tool_started' && event.toolCallId === 'call-dup',
  );
  expect(starts.length).toBe(1);
  expect(starts[0]!.arguments).toEqual({ command: 'npm test' });
});
