import test from 'ava';
import { ConversationSession } from '../../dist/services/conversation-session.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => {},
  clearCorrelationId: () => {},
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

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  const emitted = [];
  for await (const ev of session.run('hi')) {
    emitted.push(ev);
  }

  t.is(emitted[0].type, 'tool_started');
  t.true(typeof emitted[0].arguments === 'object');
  t.is(emitted[0].arguments.command, 'echo hi');
});
