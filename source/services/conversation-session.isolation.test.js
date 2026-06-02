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

const sessionContextService = {
  runWithContext: (_context, fn) => fn(),
  getContext: () => null,
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

test('sessions do not share previousResponseId', async (t) => {
  const streamsByText = {
    A1: new MockStream([]),
    A2: new MockStream([]),
    B1: new MockStream([]),
  };
  streamsByText.A1.lastResponseId = 'resp-A1';
  streamsByText.A1.finalOutput = 'A1 done.';
  streamsByText.B1.lastResponseId = 'resp-B1';
  streamsByText.B1.finalOutput = 'B1 done.';
  streamsByText.A2.lastResponseId = 'resp-A2';
  streamsByText.A2.finalOutput = 'A2 done.';

  const startCalls = [];
  const mockClient = {
    async startStream(text, options) {
      startCalls.push({ text, options });
      return streamsByText[text];
    },
  };

  const sessionA = new ConversationSession('A', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const sessionB = new ConversationSession('B', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });

  await sessionA.sendMessage('A1');
  await sessionB.sendMessage('B1');
  await sessionA.sendMessage('A2');

  t.deepEqual(startCalls, [
    { text: 'A1', options: { previousResponseId: null, sessionId: 'A' } },
    { text: 'B1', options: { previousResponseId: null, sessionId: 'B' } },
    { text: 'A2', options: { previousResponseId: 'resp-A1', sessionId: 'A' } },
  ]);
});

test('sessions do not share pending approval context', async (t) => {
  const interruption = {
    name: 'bash',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo hi' }),
  };

  const streamA = new MockStream([]);
  streamA.interruptions = [interruption];
  streamA.state = {
    approveCalls: [],
    rejectCalls: [],
    approve(arg) {
      this.approveCalls.push(arg);
    },
    reject(arg) {
      this.rejectCalls.push(arg);
    },
  };

  const streamB = new MockStream([{ type: 'response.output_text.delta', delta: 'Hello' }]);
  streamB.finalOutput = 'Hello';
  streamB.lastResponseId = 'resp-B1';

  const continuationA = new MockStream([{ type: 'response.output_text.delta', delta: 'Approved' }]);
  continuationA.finalOutput = 'Approved';

  const mockClient = {
    async startStream(text) {
      if (text === 'needs approval') return streamA;
      if (text === 'normal') return streamB;
      throw new Error(`Unexpected input: ${text}`);
    },
    async continueRunStream(state) {
      t.is(state, streamA.state);
      return continuationA;
    },
  };

  const sessionA = new ConversationSession('A', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const sessionB = new ConversationSession('B', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });

  const approvalResult = await sessionA.sendMessage('needs approval');
  t.is(approvalResult.type, 'approval_required');

  const normalResult = await sessionB.sendMessage('normal');
  t.is(normalResult.type, 'response');
  t.is(normalResult.finalText, 'Hello');

  const bApproval = await sessionB.handleApprovalDecision('y');
  t.is(bApproval, null);

  const aFinal = await sessionA.handleApprovalDecision('y');
  t.is(aFinal.type, 'response');
  t.is(aFinal.finalText, 'Approved');
});

test('queueModeNotice prefixes the next user message in stream input (chaining provider)', async (t) => {
  const startCalls = [];
  const mockStream = new MockStream([]);
  mockStream.lastResponseId = 'resp-notice';
  mockStream.finalOutput = 'Ack';

  let currentProvider = 'openai';

  const mockClient = {
    getProvider() {
      return currentProvider;
    },
    async startStream(text, options) {
      startCalls.push({ text, options });
      return mockStream;
    },
  };

  const session = new ConversationSession('notice-test-chaining', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });

  session.queueModeNotice('Mode change notice chaining');
  await session.sendMessage('User msg');

  t.is(startCalls.length, 1);
  t.is(startCalls[0].text, 'Mode change notice chaining\n\nUser msg');
});

test('queueModeNotice prefixes the next user message in stream input (non-chaining provider)', async (t) => {
  const startCalls = [];
  const mockStream = new MockStream([]);
  mockStream.lastResponseId = 'resp-notice';
  mockStream.finalOutput = 'Ack';

  const mockClient = {
    getProvider() {
      return 'openrouter';
    },
    async startStream(text, options) {
      startCalls.push({ text, options });
      return mockStream;
    },
  };

  const session = new ConversationSession('notice-test-non-chaining', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });

  session.queueModeNotice('Mode change notice non-chaining');
  await session.sendMessage('User msg');

  t.is(startCalls.length, 1);
  const passedHistory = startCalls[0].text;
  t.true(Array.isArray(passedHistory));
  t.is(passedHistory.length, 1);
  t.deepEqual(passedHistory[0], {
    role: 'user',
    type: 'message',
    content: 'Mode change notice non-chaining\n\nUser msg',
  });

  // The notice is persisted as part of the user turn, not as a separate turn.
  const persisted = session.exportState().history;
  t.is(persisted.length, 1);
  t.is((persisted[0].rawItem ?? persisted[0]).content, 'Mode change notice non-chaining\n\nUser msg');
});

test('queueModeNotice preserves prefix stability by modifying only the next user turn (non-chaining)', async (t) => {
  const startCalls = [];

  const mockClient = {
    getProvider() {
      return 'openrouter';
    },
    async startStream(text, options) {
      startCalls.push({ text, options });
      const stream = new MockStream([]);
      stream.lastResponseId = `resp-${startCalls.length}`;
      stream.finalOutput = `Reply ${startCalls.length}`;
      return stream;
    },
  };

  const session = new ConversationSession('notice-prefix-stability', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });

  // Turn 1: establish a conversation prefix with no notice.
  await session.sendMessage('First question');
  const turn1Input = startCalls[0].text;

  // Turn 2: switch modes mid-session, then send another message.
  session.queueModeNotice('Plan Mode toggled OFF');
  await session.sendMessage('Second question');
  const turn2Input = startCalls[1].text;

  // Turn 3: a normal message with no notice.
  await session.sendMessage('Third question');
  const turn3Input = startCalls[2].text;

  // Turn 2's input is turn 1's prefix grown by the next user turn with the
  // notice prefixed. Turn 3's input is turn 2's input grown by the next user
  // turn. Nothing is reordered or removed, so the prompt cache prefix grows.
  t.deepEqual(turn2Input.slice(0, turn1Input.length), turn1Input);
  t.deepEqual(turn3Input.slice(0, turn2Input.length), turn2Input);

  // The notice stays attached to the user turn at a stable position.
  const noticeIdx = turn3Input.findIndex(
    (i) => (i.rawItem ?? i).role === 'user' && (i.rawItem ?? i).content === 'Plan Mode toggled OFF\n\nSecond question',
  );
  t.true(noticeIdx >= 0);
  t.is((turn3Input[noticeIdx].rawItem ?? turn3Input[noticeIdx]).content, 'Plan Mode toggled OFF\n\nSecond question');
});
