import { it, expect } from 'vitest';
import { createConversationSession } from '../../test-helpers/conversation-session-with-adapter.js';
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
} as any;

const sessionContextService = {
  runWithContext: (_context: any, fn: () => any) => fn(),
  getContext: () => null,
};

it('sessions do not share previousResponseId', async () => {
  const streamsByText: Record<string, MockStream<never>> = {
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

  const startCalls: any[] = [];
  const mockClient = {
    async startStream(text: string, options: any) {
      startCalls.push({ text, options });
      return streamsByText[text];
    },
  } as any;

  const bundleA = createConversationSession({
    sessionId: 'A',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { terminalAdapter: terminalAdapterA } = bundleA;
  const bundleB = createConversationSession({
    sessionId: 'B',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { terminalAdapter: terminalAdapterB } = bundleB;

  await terminalAdapterA.sendMessage('A1');
  await terminalAdapterB.sendMessage('B1');
  await terminalAdapterA.sendMessage('A2');

  expect(startCalls).toEqual([
    { text: 'A1', options: { previousResponseId: null, sessionId: 'A' } },
    { text: 'B1', options: { previousResponseId: null, sessionId: 'B' } },
    { text: 'A2', options: { previousResponseId: 'resp-A1', sessionId: 'A' } },
  ]);
});

it('sessions do not share pending approval context', async () => {
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
    approve(arg: any) {
      (this as any).approveCalls.push(arg);
    },
    reject(arg: any) {
      (this as any).rejectCalls.push(arg);
    },
  } as any;

  const streamB = new MockStream([{ type: 'response.output_text.delta', delta: 'Hello' }]);
  streamB.finalOutput = 'Hello';
  streamB.lastResponseId = 'resp-B1';

  const continuationA = new MockStream([{ type: 'response.output_text.delta', delta: 'Approved' }]);
  continuationA.finalOutput = 'Approved';

  const mockClient = {
    async startStream(text: string) {
      if (text === 'needs approval') return streamA;
      if (text === 'normal') return streamB;
      throw new Error(`Unexpected input: ${text}`);
    },
    async continueRunStream(state: any) {
      expect(state).toBe(streamA.state);
      return continuationA;
    },
  } as any;

  const bundleA = createConversationSession({
    sessionId: 'A',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { terminalAdapter: terminalAdapterA } = bundleA;
  const bundleB = createConversationSession({
    sessionId: 'B',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { terminalAdapter: terminalAdapterB } = bundleB;

  const approvalResult = await terminalAdapterA.sendMessage('needs approval');
  expect(approvalResult.type).toBe('approval_required');

  const normalResult: any = await terminalAdapterB.sendMessage('normal');
  expect(normalResult.type).toBe('response');
  expect(normalResult.finalText).toBe('Hello');

  const bApproval = await terminalAdapterB.handleApprovalDecision('y');
  expect(bApproval).toBe(null);

  const aFinal: any = await terminalAdapterA.handleApprovalDecision('y');
  expect(aFinal.type).toBe('response');
  expect(aFinal.finalText).toBe('Approved');
});

it('queueModeNotice prefixes the next user message in stream input (chaining provider)', async () => {
  const startCalls: any[] = [];
  const mockStream = new MockStream([]);
  mockStream.lastResponseId = 'resp-notice';
  mockStream.finalOutput = 'Ack';

  const currentProvider = 'openai';

  const mockClient = {
    getProvider() {
      return currentProvider;
    },
    async startStream(text: string, options: any) {
      startCalls.push({ text, options });
      return mockStream;
    },
  } as any;

  const bundle = createConversationSession({
    sessionId: 'notice-test-chaining',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { terminalAdapter, stateFacade } = bundle;

  stateFacade.queueModeNotice('Mode change notice chaining');
  await terminalAdapter.sendMessage('User msg');

  expect(startCalls.length).toBe(1);
  expect(startCalls[0].text).toBe('Mode change notice chaining\n\nUser msg');
});

it('queueModeNotice prefixes the next user message in stream input (non-chaining provider)', async () => {
  const startCalls: any[] = [];
  const mockStream = new MockStream([]);
  mockStream.lastResponseId = 'resp-notice';
  mockStream.finalOutput = 'Ack';

  const mockClient = {
    getProvider() {
      return 'openrouter';
    },
    async startStream(text: string, options: any) {
      startCalls.push({ text, options });
      return mockStream;
    },
  } as any;

  const bundle = createConversationSession({
    sessionId: 'notice-test-non-chaining',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { terminalAdapter, stateFacade } = bundle;

  stateFacade.queueModeNotice('Mode change notice non-chaining');
  await terminalAdapter.sendMessage('User msg');

  expect(startCalls.length).toBe(1);
  const passedHistory = startCalls[0].text;
  expect(Array.isArray(passedHistory)).toBe(true);
  expect(passedHistory.length).toBe(1);
  expect(passedHistory[0]).toEqual({
    role: 'user',
    type: 'message',
    content: 'Mode change notice non-chaining\n\nUser msg',
  });

  // The notice is persisted as part of the user turn, not as a separate turn.
  const persisted = stateFacade.exportState().history as any[];
  expect(persisted.length).toBe(1);
  expect((persisted[0].rawItem ?? persisted[0]).content).toBe('Mode change notice non-chaining\n\nUser msg');
});

it('queueModeNotice preserves prefix stability by modifying only the next user turn (non-chaining)', async () => {
  const startCalls: any[] = [];

  const mockClient = {
    getProvider() {
      return 'openrouter';
    },
    async startStream(text: string, options: any) {
      startCalls.push({ text, options });
      const stream = new MockStream([]);
      stream.lastResponseId = `resp-${startCalls.length}`;
      stream.finalOutput = `Reply ${startCalls.length}`;
      return stream;
    },
  } as any;

  const bundle = createConversationSession({
    sessionId: 'notice-prefix-stability',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { terminalAdapter, stateFacade } = bundle;

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
  expect(turn2Input.slice(0, turn1Input.length)).toEqual(turn1Input);
  expect(turn3Input.slice(0, turn2Input.length)).toEqual(turn2Input);

  // The notice stays attached to the user turn at a stable position.
  const noticeIdx = turn3Input.findIndex(
    (i: any) =>
      (i.rawItem ?? i).role === 'user' && (i.rawItem ?? i).content === 'Plan Mode toggled OFF\n\nSecond question',
  );
  expect(noticeIdx >= 0).toBe(true);
  expect((turn3Input[noticeIdx].rawItem ?? turn3Input[noticeIdx]).content).toBe(
    'Plan Mode toggled OFF\n\nSecond question',
  );
});

it('aborted approval resolution restores cached tool arguments for command messages', async () => {
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
  } as any;

  const bundle = createConversationSession({
    sessionId: 'abort-restore-stability',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator, terminalAdapter } = bundle;

  const approvalResult = await terminalAdapter.sendMessage('run the approved shell command');
  expect(approvalResult.type).toBe('approval_required');

  turnCoordinator.abort();

  const emitted: any[] = [];
  for await (const event of turnCoordinator.start('resume the aborted approval')) {
    emitted.push(event);
  }

  const commandMessage = emitted.find((event: any) => event.type === 'command_message');
  expect(commandMessage).toBeTruthy();
  expect(commandMessage!.message.command).toBe('shell "echo restored-args"');
});
