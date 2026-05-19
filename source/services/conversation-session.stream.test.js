import test from 'ava';
import { ModelBehaviorError } from '@openai/agents';
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

test('run() falls back to standard service tier after flex timeout', async (t) => {
  const timeoutError = new Error(
    'data: {"error":{"code":504,"message":"The operation was aborted","metadata":{"error_type":"timeout"}}}',
  );
  const successStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Recovered' }]);
  successStream.finalOutput = 'Recovered';
  const calls = [];

  const mockClient = {
    shouldRetryWithoutFlexServiceTier(error) {
      return error === timeoutError;
    },
    useStandardServiceTierForNextRequest() {
      calls.push('fallback');
    },
    async startStream(input) {
      calls.push(input);
      if (calls.length === 1) {
        throw timeoutError;
      }
      return successStream;
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
    emitted.map((event) => event.type),
    ['retry', 'text_delta', 'final'],
  );
  t.is(emitted[0].retryType, 'flex_service_tier');
  t.is(emitted[0].toolName, 'service_tier');
  t.deepEqual(calls, ['hi', 'fallback', 'hi']);
});

test('run() retries streamed recoverable errors without committing failed stream history', async (t) => {
  class FailingStream extends MockStream {
    constructor() {
      super([]);
      this.history = [
        { role: 'user', type: 'message', content: 'retry me' },
        { type: 'function_call', callId: 'failed-call', name: 'fake_tool', arguments: '{}' },
        {
          type: 'function_call_result',
          callId: 'failed-call',
          name: 'fake_tool',
          output: { type: 'text', text: 'partial failed output' },
        },
      ];
    }

    async *[Symbol.asyncIterator]() {
      yield { type: 'response.output_text.delta', delta: 'partial' };
      throw new ModelBehaviorError('Tool fake_tool not found in agent Terminal Assistant.');
    }
  }

  const successStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Recovered' }]);
  successStream.finalOutput = 'Recovered';
  successStream.history = [
    { role: 'user', type: 'message', content: 'retry me' },
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Recovered' }] },
  ];

  const calls = [];
  const mockClient = {
    getProvider() {
      return 'openrouter';
    },
    async startStream(input) {
      calls.push(input);
      return calls.length === 1 ? new FailingStream() : successStream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  const emitted = [];
  for await (const ev of session.run('retry me')) {
    emitted.push(ev);
  }

  t.deepEqual(
    emitted.map((event) => event.type),
    ['text_delta', 'retry', 'text_delta', 'final'],
  );
  t.is(calls.length, 2);
  t.is(calls[0].length, 1);
  t.deepEqual(calls[1], [{ role: 'user', type: 'message', content: 'retry me' }]);
});

test('run() blocks abrupt outbound message-count surge before provider call', async (t) => {
  const firstStream = new MockStream([{ type: 'response.output_text.delta', delta: 'ok' }]);
  firstStream.finalOutput = 'ok';
  firstStream.history = Array.from({ length: 863 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    type: 'message',
    content: `history-${index}`,
    ...(index % 2 === 1 ? { status: 'completed' } : {}),
  }));

  const calls = [];
  const mockClient = {
    getProvider() {
      return 'opencode';
    },
    async startStream(input) {
      calls.push(input);
      return firstStream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  session.importState({
    previousResponseId: null,
    history: Array.from({ length: 65 }, (_, index) => ({ role: 'user', type: 'message', content: `seed-${index}` })),
  });

  const first = [];
  for await (const ev of session.run('first')) {
    first.push(ev);
  }

  const second = [];
  for await (const ev of session.run('second')) {
    second.push(ev);
  }

  t.is(calls.length, 1);
  t.is(calls[0].length, 66);
  t.deepEqual(second, [
    {
      type: 'error',
      kind: 'input_surge_guard',
      message:
        'Outgoing message count jumped from 66 to 930. Request blocked to prevent runaway context growth. Try /undo or /clear, or compact the conversation history.',
    },
  ]);
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
    ['tool_started', 'text_delta', 'final'],
  );
  t.is(cont[0].type, 'tool_started');
  t.is(cont[0].toolCallId, 'call-xyz');
  t.is(cont[0].toolName, 'bash');

  t.is(cont[1].delta, 'Approved run');
  t.is(cont[2].finalText, 'Approved run');
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

test('sendMessage() preserves cache usage from streaming events when final usage omits it', async (t) => {
  const events = [
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_tokens_details: { cached_tokens: 60 },
          },
        },
      },
    },
  ];

  const stream = new MockStream(events, {
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
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
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    cache_read_tokens: 60,
  });
});

test('run() emits usage_update when usage is nested in event.data (raw_model_stream_event)', async (t) => {
  // Simulates a raw_model_stream_event with type 'response.completed' where
  // usage lives at event.data.response.usage
  const events = [
    { type: 'response.output_text.delta', delta: 'Hello' },
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'response.completed',
        response: {
          usage: { input_tokens: 50, output_tokens: 25 },
        },
      },
    },
  ];

  const stream = new MockStream(events);
  stream.finalOutput = 'Hello';

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

  const usageEvents = emitted.filter((e) => e.type === 'usage_update');
  t.true(usageEvents.length >= 1, 'Should emit at least one usage_update event');
  t.is(usageEvents[0].usage.prompt_tokens, 50);
  t.is(usageEvents[0].usage.completion_tokens, 25);
  t.is(usageEvents[0].usage.total_tokens, 75);
});

test('run() emits usage_update when raw model stream usage is nested in event.data.event', async (t) => {
  const events = [
    { type: 'response.output_text.delta', delta: 'Hello' },
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: {
          id: '8d03b4e8-46ab-45f7-aed4-670157c3dd6d',
          object: 'chat.completion.chunk',
          created: 1778912418,
          model: 'deepseek-v4-flash',
          usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
        },
        providerData: {
          rawModelEventSource: 'openai-chat-completions',
        },
      },
    },
  ];

  const stream = new MockStream(events);
  stream.finalOutput = 'Hello';

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

  const usageEvents = emitted.filter((e) => e.type === 'usage_update');
  t.true(usageEvents.length >= 1, 'Should emit at least one usage_update event');
  t.is(usageEvents[0].usage.prompt_tokens, 8);
  t.is(usageEvents[0].usage.completion_tokens, 3);
  t.is(usageEvents[0].usage.total_tokens, 11);
});

test('run() emits usage_update when usage is at top level of event', async (t) => {
  // Simulates events that have usage directly on the event (e.g. response.done)
  const events = [
    { type: 'response.output_text.delta', delta: 'Hello' },
    {
      type: 'response.done',
      response: {
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    },
  ];

  const stream = new MockStream(events);
  stream.finalOutput = 'Hello';

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

  const usageEvents = emitted.filter((e) => e.type === 'usage_update');
  t.true(usageEvents.length >= 1, 'Should emit at least one usage_update event');
  t.is(usageEvents[0].usage.prompt_tokens, 100);
  t.is(usageEvents[0].usage.completion_tokens, 50);
  t.is(usageEvents[0].usage.total_tokens, 150);
});

test('undoLastUserTurn() returns { text, imageCount: 0 } after a completed run', async (t) => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Reply' }]);
  stream.finalOutput = 'Reply';
  stream.history = [
    { role: 'user', type: 'message', content: 'hello' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Reply' }] },
  ];

  const mockClient = {
    async startStream() {
      return stream;
    },
    getProvider() {
      return 'openrouter';
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  for await (const _ of session.run('hello')) {
    // consume
  }

  const result = session.undoLastUserTurn();
  t.deepEqual(result, { text: 'hello', imageCount: 0 });
});

test('undoLastUserTurn() returns null when no genuine user turn exists', async (t) => {
  const mockClient = {
    async startStream() {
      return new MockStream([]);
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  const result = session.undoLastUserTurn();
  t.is(result, null);
});

test('generation guard: gated run updateFromResult is skipped after undoLastUserTurn', async (t) => {
  // Turn 1: run to completion so the store has msg1's history.
  const stream1 = new MockStream([{ type: 'response.output_text.delta', delta: 'Reply1' }]);
  stream1.finalOutput = 'Reply1';
  stream1.history = [
    { role: 'user', type: 'message', content: 'msg1' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Reply1' }] },
  ];

  // Turn 2 (gated): a stream that yields one event then waits for a gate promise before "finishing".
  // We implement this by resolving a deferred to control when the async iterator returns.
  let gateResolve;
  const gate = new Promise((resolve) => {
    gateResolve = resolve;
  });

  class GatedStream {
    constructor() {
      this.lastResponseId = 'resp_gated';
      this.interruptions = [];
      this.state = {};
      this.newItems = [];
      this.history = [
        { role: 'user', type: 'message', content: 'msg2' },
        { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Reply2' }] },
      ];
      this.finalOutput = 'Reply2';
    }

    async *[Symbol.asyncIterator]() {
      yield { type: 'response.output_text.delta', delta: 'Reply2' };
      await gate;
    }
  }

  // Turn 3: capture the input so we can assert the history array.
  let msg3Input;
  const stream3 = new MockStream([{ type: 'response.output_text.delta', delta: 'Reply3' }]);
  stream3.finalOutput = 'Reply3';
  stream3.history = [
    { role: 'user', type: 'message', content: 'msg1' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Reply1' }] },
    { role: 'user', type: 'message', content: 'msg3' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Reply3' }] },
  ];

  let callCount = 0;
  const mockClient = {
    async startStream(input) {
      callCount++;
      if (callCount === 1) return stream1;
      if (callCount === 2) return new GatedStream();
      msg3Input = input;
      return stream3;
    },
    getProvider() {
      return 'openrouter';
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  // (a) Run msg1 to completion — store now has msg1 + Reply1.
  for await (const _ of session.run('msg1')) {
    // consume
  }

  // (b) Begin msg2 in a background IIFE — it will block on the gate.
  const msg2Done = (async () => {
    const events = [];
    for await (const ev of session.run('msg2')) {
      events.push(ev);
    }
    return events;
  })();

  // Give the IIFE a chance to start and reach the gate (one microtask tick is enough).
  await Promise.resolve();

  // (c) While msg2 is gated, undo it — bumps generation.
  const undone = session.undoLastUserTurn();
  t.deepEqual(undone, { text: 'msg2', imageCount: 0 });

  // (d) Resolve the gate so the gated run completes (but its updateFromResult should be skipped).
  gateResolve();
  await msg2Done;

  // (e) Issue msg3 and capture the input passed to startStream.
  for await (const _ of session.run('msg3')) {
    // consume
  }

  // The input to startStream for msg3 must contain msg1 but NOT msg2.
  t.true(Array.isArray(msg3Input), 'msg3 should receive history array');
  const contents = msg3Input.map((item) => item.content);
  t.true(contents.includes('msg1'), 'history should contain msg1');
  t.false(contents.includes('msg2'), 'history must NOT contain msg2 (generation guard worked)');
});

test('run() throws AbortError when the stream is cancelled/aborted', async (t) => {
  const stream = new MockStream([]);
  stream.cancelled = true;

  const mockClient = {
    async startStream() {
      return stream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  await t.throwsAsync(
    async () => {
      for await (const _ of session.run('hi')) {
        void _;
      }
    },
    { name: 'AbortError' },
  );
});
