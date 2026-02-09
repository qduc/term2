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

test('run() streams ConversationEvents (text_delta → final) in order', async (t) => {
  const events = [
    { type: 'response.output_text.delta', delta: 'Hello' },
    { type: 'response.output_text.delta', delta: ' world' },
  ];

  const stream = new MockStream(events);
  stream.finalOutput = 'Hello world';
  stream.lastResponseId = 'resp-1';

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

  t.deepEqual(
    emitted.map((e) => e.type),
    ['text_delta', 'text_delta', 'final'],
  );
  t.is(emitted[0].delta, 'Hello');
  t.is(emitted[0].fullText, 'Hello');
  t.is(emitted[1].delta, ' world');
  t.is(emitted[1].fullText, 'Hello world');
  t.is(emitted[2].finalText, 'Hello world');
});

test('continue() streams events after approval decision', async (t) => {
  const interruption = {
    name: 'bash',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo hi' }),
    callId: 'call-xyz',
  };

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.state = {
    approveCalls: [],
    rejectCalls: [],
    approve(arg) {
      this.approveCalls.push(arg);
    },
    reject(arg) {
      this.rejectCalls.push(arg);
    },
  };

  const continuationStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Approved run' }]);
  continuationStream.finalOutput = 'Approved run';

  const mockClient = {
    async startStream() {
      return initialStream;
    },
    async continueRunStream(state) {
      t.is(state, initialStream.state);
      return continuationStream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  const first = [];
  for await (const ev of session.run('run command')) {
    first.push(ev);
  }
  t.is(first.length, 1);
  t.is(first[0].type, 'approval_required');
  t.is(first[0].approval.callId, 'call-xyz');

  const cont = [];
  for await (const ev of session.continue({ answer: 'y' })) {
    cont.push(ev);
  }

  t.deepEqual(
    cont.map((e) => e.type),
    ['text_delta', 'final'],
  );
  t.is(cont[0].delta, 'Approved run');
  t.is(cont[1].finalText, 'Approved run');
});

test('sendMessage() preserves callId on approval_required terminal result', async (t) => {
  const interruption = {
    name: 'shell',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo hi' }),
    callId: 'call-preserve-1',
  };

  const stream = new MockStream([]);
  stream.interruptions = [interruption];
  stream.state = {
    approve() {},
    reject() {},
  };

  const mockClient = {
    async startStream() {
      return stream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  const result = await session.sendMessage('run command');
  t.is(result.type, 'approval_required');
  t.is(result.approval.callId, 'call-preserve-1');
});

test('handleApprovalDecision() preserves callId on subsequent approval_required terminal result', async (t) => {
  const firstInterruption = {
    name: 'shell',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo first' }),
    callId: 'call-first',
  };

  const secondInterruption = {
    name: 'apply_patch',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ path: 'a.ts' }),
    callId: 'call-second',
  };

  const initialStream = new MockStream([]);
  initialStream.interruptions = [firstInterruption];
  initialStream.state = {
    approveCalls: [],
    approve(arg) {
      this.approveCalls.push(arg);
    },
    reject() {},
  };

  const continuationStream = new MockStream([]);
  continuationStream.interruptions = [secondInterruption];

  const mockClient = {
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      return continuationStream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  const first = await session.sendMessage('run command');
  t.is(first.type, 'approval_required');
  t.is(first.approval.callId, 'call-first');

  const second = await session.handleApprovalDecision('y');
  t.truthy(second);
  t.is(second?.type, 'approval_required');
  if (second?.type === 'approval_required') {
    t.is(second.approval.callId, 'call-second');
  }
});

test('run() sends text for OpenAI provider (server-side state)', async (t) => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';

  let receivedInput;
  const mockClient = {
    async startStream(input) {
      receivedInput = input;
      return stream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  const emitted = [];
  for await (const ev of session.run('Hello')) {
    emitted.push(ev);
  }

  // OpenAI should receive just the text string (no getProvider means default 'openai')
  t.is(typeof receivedInput, 'string');
  t.is(receivedInput, 'Hello');
  t.is(emitted[emitted.length - 1].type, 'final');
});

test('run() sends full history for non-OpenAI providers (client-side state)', async (t) => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';
  stream.history = [
    { role: 'user', type: 'message', content: 'Hello' },
    {
      role: 'assistant',
      type: 'message',
      content: [{ type: 'output_text', text: 'Response' }],
    },
  ];

  let receivedInput;
  const mockClient = {
    async startStream(input) {
      receivedInput = input;
      return stream;
    },
    getProvider() {
      return 'openrouter'; // Non-OpenAI provider
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  const emitted = [];
  for await (const ev of session.run('Hello')) {
    emitted.push(ev);
  }

  // Non-OpenAI providers should receive full history array
  t.true(Array.isArray(receivedInput));
  t.is(receivedInput.length, 1); // Initial user message
  t.is(receivedInput[0].role, 'user');
  t.is(receivedInput[0].content, 'Hello');
  t.is(emitted[emitted.length - 1].type, 'final');
});

test('run() sends full history for openai-compatible providers', async (t) => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';
  stream.history = [
    { role: 'user', type: 'message', content: 'First message' },
    {
      role: 'assistant',
      type: 'message',
      content: [{ type: 'output_text', text: 'First response' }],
    },
    { role: 'user', type: 'message', content: 'Second message' },
    {
      role: 'assistant',
      type: 'message',
      content: [{ type: 'output_text', text: 'Response' }],
    },
  ];

  let firstInput, secondInput;
  let callCount = 0;
  const mockClient = {
    async startStream(input) {
      callCount++;
      if (callCount === 1) {
        firstInput = input;
      } else {
        secondInput = input;
      }
      return stream;
    },
    getProvider() {
      return 'deepseek'; // Custom openai-compatible provider
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  // First message
  for await (const ev of session.run('First message')) {
    // consume events
  }

  // OpenAI-compatible provider should receive full history array
  t.true(Array.isArray(firstInput));
  t.is(firstInput.length, 1);
  t.is(firstInput[0].content, 'First message');

  // Second message should contain both previous and new message
  for await (const ev of session.run('Second message')) {
    // consume events
  }

  t.true(Array.isArray(secondInput));
  t.true(secondInput.length >= 2, 'Second call should include conversation history');
});

test('sendMessage() returns usage from final event', async (t) => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';
  stream.completed = Promise.resolve({
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
  });

  const mockClient = {
    async startStream() {
      return stream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  const result = await session.sendMessage('Hello');

  t.is(result.type, 'response');
  t.deepEqual(result.usage, {
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
  });
});

test('handleApprovalDecision() returns usage from final event', async (t) => {
  const interruption = {
    name: 'bash',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo hi' }),
    callId: 'call-xyz',
  };

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.state = {
    approve() {},
    reject() {},
  };

  const continuationStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Approved run' }]);
  continuationStream.finalOutput = 'Approved run';
  continuationStream.completed = Promise.resolve({
    usage: { inputTokens: 21, outputTokens: 9, totalTokens: 30 },
  });

  const mockClient = {
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      return continuationStream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  const approvalResult = await session.sendMessage('run command');
  t.is(approvalResult.type, 'approval_required');

  const finalResult = await session.handleApprovalDecision('y');
  t.is(finalResult.type, 'response');
  t.deepEqual(finalResult.usage, {
    prompt_tokens: 21,
    completion_tokens: 9,
    total_tokens: 30,
  });
});

test('sendMessage() logs usage handoff at DEBUG level', async (t) => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';
  stream.completed = Promise.resolve({
    usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
  });

  const debugLogs = [];
  const logger = {
    ...mockLogger,
    debug: (message, meta) => {
      debugLogs.push({ message, meta });
    },
  };

  const mockClient = {
    async startStream() {
      return stream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger },
  });

  await session.sendMessage('Hello');

  const hasUsageReturnLog = debugLogs.some(
    (log) => log.message === 'sendMessage returning response' && log.meta?.hasUsage === true,
  );
  t.true(hasUsageReturnLog);
});

test('logs diagnostics when usage is missing in stream completion', async (t) => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';
  stream.completed = Promise.resolve({ foo: 'bar' });

  const debugLogs = [];
  const logger = {
    ...mockLogger,
    debug: (message, meta) => {
      debugLogs.push({ message, meta });
    },
  };

  const mockClient = {
    async startStream() {
      return stream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger },
  });

  await session.sendMessage('Hello');

  const missingUsageLog = debugLogs.find((log) => log.message === 'No usage found in stream completion');
  t.truthy(missingUsageLog);
  t.true(Array.isArray(missingUsageLog.meta?.completedResultKeys), 'completedResultKeys should be present');
});

test('sendMessage() extracts usage from stream.rawResponses when completed is void', async (t) => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';
  stream.completed = Promise.resolve(undefined);
  stream.rawResponses = [{ usage: { inputTokens: 13, outputTokens: 8, totalTokens: 21 } }];

  const mockClient = {
    async startStream() {
      return stream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  const result = await session.sendMessage('Hello');
  t.is(result.type, 'response');
  t.deepEqual(result.usage, {
    prompt_tokens: 13,
    completion_tokens: 8,
    total_tokens: 21,
  });
});
