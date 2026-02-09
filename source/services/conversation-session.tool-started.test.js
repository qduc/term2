import test from 'ava';
import { ConversationSession } from '../../dist/services/conversation-session.js';

const createMockLogger = () => {
  const events = [];
  return {
    events,
    logger: {
      info: (_message, meta) => {
        events.push({ level: 'info', meta });
      },
      warn: (_message, meta) => {
        events.push({ level: 'warn', meta });
      },
      error: (_message, meta) => {
        events.push({ level: 'error', meta });
      },
      debug: (_message, meta) => {
        events.push({ level: 'debug', meta });
      },
      security: () => {},
      setCorrelationId: () => {},
      getCorrelationId: () => 'trace-test-1',
      clearCorrelationId: () => {},
    },
  };
};

class MockStream {
  constructor(events) {
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

test('run() emits tool_started with parsed arguments when function_call arguments are JSON string', async (t) => {
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

  const mockClient = {
    async startStream() {
      return stream;
    },
  };

  const { logger } = createMockLogger();
  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger },
  });

  const emitted = [];
  for await (const ev of session.run('hi')) {
    emitted.push(ev);
  }

  t.is(emitted[0].type, 'tool_started');
  t.true(typeof emitted[0].arguments === 'object');
  t.is(emitted[0].arguments.command, 'echo hi');
});

test('run() emits one diagnostic packet when tool arguments contain malformed JSON', async (t) => {
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

  const mockClient = {
    async startStream() {
      return stream;
    },
  };

  const { logger, events } = createMockLogger();
  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger },
  });

  for await (const _ev of session.run('hi')) {
    // consume stream
  }

  const packets = events.filter(
    (entry) => entry.level === 'error' && entry.meta?.eventType === 'tool_call.parse_failed',
  );
  t.is(packets.length, 1);
  t.is(packets[0].meta.errorCode, 'INVALID_TOOL_CALL_FORMAT');
  t.is(packets[0].meta.traceId, 'trace-test-1');
  t.true(Array.isArray(packets[0].meta.validationErrors));
});
