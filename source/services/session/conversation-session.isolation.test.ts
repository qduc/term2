// @ts-nocheck - Complex mock patterns deferred to follow-up
import test from 'ava';
import { createConversationSession } from './session-composition.js';
import { MockStream } from '../test-helpers/mock-stream.js';

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

  const bundleA = createConversationSession({
    sessionId: 'A',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session: sessionA, terminalAdapter: terminalAdapterA, stateFacade: stateFacadeA } = bundleA;
  const bundleB = createConversationSession({
    sessionId: 'B',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session: sessionB, terminalAdapter: terminalAdapterB, stateFacade: stateFacadeB } = bundleB;

  await terminalAdapterA.sendMessage('A1');
  await terminalAdapterB.sendMessage('B1');
  await terminalAdapterA.sendMessage('A2');

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

  const bundleA = createConversationSession({
    sessionId: 'A',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session: sessionA, terminalAdapter: terminalAdapterA, stateFacade: stateFacadeA } = bundleA;
  const bundleB = createConversationSession({
    sessionId: 'B',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session: sessionB, terminalAdapter: terminalAdapterB, stateFacade: stateFacadeB } = bundleB;

  const approvalResult = await terminalAdapterA.sendMessage('needs approval');
  t.is(approvalResult.type, 'approval_required');

  const normalResult = await terminalAdapterB.sendMessage('normal');
  t.is(normalResult.type, 'response');
  t.is(normalResult.finalText, 'Hello');

  const bApproval = await terminalAdapterB.handleApprovalDecision('y');
  t.is(bApproval, null);

  const aFinal = await terminalAdapterA.handleApprovalDecision('y');
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

  const bundle = createConversationSession({
    sessionId: 'notice-test-chaining',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade } = bundle;

  stateFacade.queueModeNotice('Mode change notice chaining');
  await terminalAdapter.sendMessage('User msg');

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

  const bundle = createConversationSession({
    sessionId: 'notice-test-non-chaining',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade } = bundle;

  stateFacade.queueModeNotice('Mode change notice non-chaining');
  await terminalAdapter.sendMessage('User msg');

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
  const persisted = stateFacade.exportState().history;
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

  const bundle = createConversationSession({
    sessionId: 'notice-prefix-stability',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade } = bundle;

  // Turn 1: establish a conversation prefix with no notice.
  await terminalAdapter.sendMessage('First question');
  const turn1Input = startCalls[0].text;

  // Turn 2: switch modes mid-session, then send another message.
  stateFacade.queueModeNotice('Plan Mode toggled OFF');
  await terminalAdapter.sendMessage('Second question');
  const turn2Input = startCalls[1].text;

  // Turn 3: a normal message with no notice.
  await terminalAdapter.sendMessage('Third question');
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

test('aborted approval resolution restores cached tool arguments for command messages', async (t) => {
  const callId = 'call-abort-restore';
  const initialStream = new MockStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId,
          name: 'shell',
          arguments: JSON.stringify({ command: 'echo restored-args' }),
        },
      },
    },
  ]);
  initialStream.interruptions = [
    {
      name: 'shell',
      agent: { name: 'CLI Agent' },
      arguments: JSON.stringify({ command: 'echo restored-args' }),
      callId,
    },
  ];
  initialStream.state = {
    approve: () => undefined,
    reject: () => undefined,
  };

  const resolvedStream = new MockStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call_output',
          callId,
          name: 'shell',
          output: 'exit 0\nrestored',
        },
      },
    },
  ]);
  resolvedStream.finalOutput = 'restored';
  resolvedStream.lastResponseId = 'resp-abort-restore';

  const mockClient = {
    abort() {},
    addToolInterceptor() {
      return () => undefined;
    },
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      return resolvedStream;
    },
  };

  const bundle = createConversationSession({
    sessionId: 'abort-restore-stability',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator, terminalAdapter, stateFacade } = bundle;

  const approvalResult = await terminalAdapter.sendMessage('run the approved shell command');
  t.is(approvalResult.type, 'approval_required');

  turnCoordinator.abort();

  const emitted = [];
  for await (const event of turnCoordinator.start('resume the aborted approval')) {
    emitted.push(event);
  }

  const commandMessage = emitted.find((event) => event.type === 'command_message');
  t.truthy(commandMessage);
  t.is(commandMessage.message.command, 'shell "echo restored-args"');
});
