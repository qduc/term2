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

test('run() warns when completed stream history already contains duplicated tool pairs', async (t) => {
  const warnings = [];
  const logger = {
    ...mockLogger,
    warn: (message, meta) => warnings.push({ message, meta }),
  };
  const stream = new MockStream([]);
  stream.history = [
    { role: 'user', type: 'message', content: 'inspect' },
    { type: 'function_call', callId: 'call-read', id: 'fc_1' },
    { type: 'function_call_result', callId: 'call-read', id: 'fcr_1', output: 'hidden' },
    { type: 'function_call', callId: 'call-read', id: 'fc_2' },
    { type: 'function_call_result', callId: 'call-read', id: 'fcr_2', output: 'hidden again' },
  ];
  stream.newItems = stream.history.slice(1);
  stream.state = { _generatedItems: stream.newItems };

  const mockClient = {
    async startStream() {
      return stream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger },
  });

  for await (const _ev of session.run('hi')) {
    // consume stream
  }

  const warning = warnings.find((entry) => entry.meta?.eventType === 'conversation.stream_history.replayed_tools');
  t.truthy(warning);
  t.is(warning.meta.phase, 'post_stream');
  t.is(warning.meta.source, 'startStream');
  t.is(warning.meta.historyDuplicatePairs, 1);
  t.is(warning.meta.newItemsDuplicatePairs, 1);
  t.is(warning.meta.stateGeneratedItemsDuplicatePairs, 1);
  t.false('output' in warning.meta);
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

test('run() exports completed tool pairs from a stream that later fails', async (t) => {
  class FailingStream extends MockStream {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'run_item_stream_event',
        item: {
          rawItem: {
            type: 'function_call',
            id: 'fc_1',
            callId: 'call-read',
            name: 'read_file',
            arguments: '{}',
          },
        },
      };
      yield {
        type: 'run_item_stream_event',
        item: {
          rawItem: {
            type: 'function_call_result',
            id: 'fcr_1',
            callId: 'call-read',
            name: 'read_file',
            output: 'contents',
          },
        },
      };
      yield {
        type: 'run_item_stream_event',
        item: {
          rawItem: {
            type: 'function_call',
            id: 'fc_2',
            callId: 'call-write',
            name: 'apply_patch',
            arguments: '{}',
          },
        },
      };
      throw new Error('context exceeded');
    }
  }

  const mockClient = {
    getProvider() {
      return 'openrouter';
    },
    async startStream() {
      return new FailingStream();
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  await t.throwsAsync(async () => {
    for await (const _ev of session.run('inspect')) {
      // consume stream
    }
  });

  const state = session.exportState();
  // Reconciled history: user message + completed call/result pair.
  // The aborted second call has no result yet, so it is not pushed into history.
  t.is(state.history.length, 3);
  t.is(state.toolLedger.length, 2);
  t.is(state.toolLedger[0].status, 'completed');
  t.is(state.toolLedger[1].status, 'aborted');
  t.deepEqual(
    state.toolLedger[0].historyItems.map((item) => item.callId),
    ['call-read', 'call-read'],
  );
});

test('run() emits tool_recovery before error when a streamed turn fails after tool activity', async (t) => {
  class FailingStream extends MockStream {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'run_item_stream_event',
        item: {
          rawItem: {
            type: 'function_call',
            id: 'fc_1',
            callId: 'call-read',
            name: 'read_file',
            arguments: '{}',
          },
        },
      };
      yield {
        type: 'run_item_stream_event',
        item: {
          rawItem: {
            type: 'function_call_result',
            id: 'fcr_1',
            callId: 'call-read',
            name: 'read_file',
            output: 'contents',
          },
        },
      };
      yield {
        type: 'run_item_stream_event',
        item: {
          rawItem: {
            type: 'function_call',
            id: 'fc_2',
            callId: 'call-write',
            name: 'apply_patch',
            arguments: '{}',
          },
        },
      };
      throw new Error('context exceeded');
    }
  }

  const mockClient = {
    getProvider() {
      return 'openrouter';
    },
    async startStream() {
      return new FailingStream();
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  const emitted = [];
  await t.throwsAsync(async () => {
    for await (const ev of session.run('inspect')) {
      emitted.push(ev);
    }
  });

  const recovery = emitted.find((event) => event.type === 'tool_recovery');
  t.truthy(recovery);
  t.deepEqual(recovery.recoveredCallIds, ['call-read']);
  t.deepEqual(recovery.droppedCallIds, ['call-write']);
  t.true(recovery.message.includes('Recovered 1 completed'));
  t.true(
    emitted.findIndex((event) => event.type === 'tool_recovery') < emitted.findIndex((event) => event.type === 'error'),
  );

  // Regression: after a mid-stream failure, completed tool call/result pairs
  // captured by the ledger must be reconciled into canonical history so the
  // next turn does not send two consecutive user messages with no tool record.
  const state = session.exportState();
  const types = state.history.map((item) => item.rawItem?.type ?? item.type);
  t.true(types.includes('function_call'));
  t.true(types.includes('function_call_result') || types.includes('function_call_output'));
});

test('importState() reconciles completed ledger pairs into canonical history', (t) => {
  const session = new ConversationSession('s1', {
    agentClient: {},
    deps: { logger: mockLogger },
  });

  session.importState({
    previousResponseId: null,
    history: [{ role: 'user', type: 'message', content: 'inspect' }],
    toolLedger: [
      {
        turnId: 'turn-1',
        callId: 'call-read',
        toolName: 'read_file',
        arguments: '{}',
        status: 'completed',
        startedAt: '2026-05-26T00:00:00.000Z',
        completedAt: '2026-05-26T00:00:01.000Z',
        historyItems: [
          { type: 'function_call', id: 'fc_1', callId: 'call-read', name: 'read_file', arguments: '{}' },
          { type: 'function_call_result', id: 'fcr_1', callId: 'call-read', output: 'contents' },
        ],
      },
      {
        turnId: 'turn-1',
        callId: 'call-write',
        toolName: 'apply_patch',
        arguments: '{}',
        status: 'aborted',
        startedAt: '2026-05-26T00:00:02.000Z',
      },
    ],
  });

  const state = session.exportState();
  t.is(state.history.length, 3);
  t.is(state.history[1].callId, 'call-read');
  t.is(state.history[2].callId, 'call-read');
});

test('run() allows a follow-up after a long non-chaining run expands full history', async (t) => {
  const firstStream = new MockStream([{ type: 'response.output_text.delta', delta: 'first' }]);
  firstStream.finalOutput = 'first';
  firstStream.history = Array.from({ length: 212 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    type: 'message',
    content: `history-${index}`,
    ...(index % 2 === 1 ? { status: 'completed' } : {}),
  }));
  const secondStream = new MockStream([{ type: 'response.output_text.delta', delta: 'second' }]);
  secondStream.finalOutput = 'second';

  const calls = [];
  const mockClient = {
    getProvider() {
      return 'opencode';
    },
    async startStream(input) {
      calls.push(input);
      return calls.length === 1 ? firstStream : secondStream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  session.importState({
    previousResponseId: null,
    history: [{ role: 'user', type: 'message', content: 'seed' }],
  });

  const first = [];
  for await (const ev of session.run('first')) {
    first.push(ev);
  }

  const second = [];
  for await (const ev of session.run('second')) {
    second.push(ev);
  }

  t.is(calls.length, 2);
  t.is(calls[0].length, 2);
  t.true(calls[1].length > 212);
  t.deepEqual(
    second.map((event) => event.type),
    ['text_delta', 'final'],
  );
});

test('sendMessage() allows a follow-up after a long non-chaining run expands full history', async (t) => {
  const firstStream = new MockStream([{ type: 'response.output_text.delta', delta: 'ok' }]);
  firstStream.finalOutput = 'ok';
  firstStream.history = Array.from({ length: 212 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    type: 'message',
    content: `history-${index}`,
    ...(index % 2 === 1 ? { status: 'completed' } : {}),
  }));
  const secondStream = new MockStream([{ type: 'response.output_text.delta', delta: 'next' }]);
  secondStream.finalOutput = 'next';

  const calls = [];
  const mockClient = {
    getProvider() {
      return 'opencode';
    },
    async startStream(input) {
      calls.push(input);
      return calls.length === 1 ? firstStream : secondStream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  session.importState({
    previousResponseId: null,
    history: [{ role: 'user', type: 'message', content: 'seed' }],
  });

  await session.sendMessage('first');
  const second = await session.sendMessage('second');

  t.is(second.type, 'response');
  t.is(calls.length, 2);
  t.true(calls[1].length > 212);
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

test('continue() retries on transient error during stream iteration', async (t) => {
  const interruption = {
    name: 'bash',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo hi' }),
    callId: 'call-retry',
  };

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.state = {
    approve(arg) {},
  };

  const failingStream = {
    lastResponseId: null,
    interruptions: [],
    state: {},
    newItems: [],
    history: [],
    finalOutput: '',
    async *[Symbol.asyncIterator]() {
      throw new Error("We're currently processing too many requests — please try again later.");
    },
  };

  const successStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Recovered' }]);
  successStream.finalOutput = 'Recovered';

  let continueCalls = 0;
  const mockClient = {
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      continueCalls++;
      return continueCalls === 1 ? failingStream : successStream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  // Trigger approval_required
  const first = [];
  for await (const ev of session.run('run command')) {
    first.push(ev);
  }
  t.is(first[0].type, 'approval_required');

  // Continue — first attempt fails, second succeeds
  const cont = [];
  for await (const ev of session.continue({ answer: 'y' })) {
    cont.push(ev);
  }

  t.is(continueCalls, 2);
  const types = cont.map((e) => e.type);
  t.true(types.includes('retry'), 'should emit a retry event');
  t.true(types.includes('final'), 'should emit a final event after retry');
  t.is(cont[cont.length - 1].finalText, 'Recovered');
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

test('run() sends full history for Codex provider and omits previousResponseId', async (t) => {
  const firstStream = new MockStream([{ type: 'response.output_text.delta', delta: 'First response' }]);
  firstStream.finalOutput = 'First response';
  firstStream.lastResponseId = 'resp-codex-1';
  firstStream.history = [
    { role: 'user', type: 'message', content: 'First message' },
    {
      role: 'assistant',
      type: 'message',
      content: [{ type: 'output_text', text: 'First response' }],
    },
  ];

  const secondStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Second response' }]);
  secondStream.finalOutput = 'Second response';
  secondStream.lastResponseId = 'resp-codex-2';
  secondStream.history = [
    ...firstStream.history,
    { role: 'user', type: 'message', content: 'Second message' },
    {
      role: 'assistant',
      type: 'message',
      content: [{ type: 'output_text', text: 'Second response' }],
    },
  ];

  const calls = [];
  const mockClient = {
    async startStream(input, opts) {
      calls.push({ input, opts });
      return calls.length === 1 ? firstStream : secondStream;
    },
    getProvider() {
      return 'codex';
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  for await (const _ of session.run('First message')) {
    // consume events
  }
  for await (const _ of session.run('Second message')) {
    // consume events
  }

  t.true(Array.isArray(calls[0].input), 'Codex should use full-history input from the first turn');
  t.falsy(calls[0].opts.previousResponseId, 'Codex should not receive a usable previousResponseId on turn 1');
  t.true(Array.isArray(calls[1].input), 'Codex should use full-history input on follow-up turns');
  t.true(calls[1].input.some((item) => item.role === 'user' && item.content === 'First message'));
  t.true(calls[1].input.some((item) => item.role === 'assistant'));
  t.true(calls[1].input.some((item) => item.role === 'user' && item.content === 'Second message'));
  t.falsy(calls[1].opts.previousResponseId, 'Codex should not receive a usable previousResponseId on turn 2');
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

test('generation guard: gated run store write is skipped after undoLastUserTurn', async (t) => {
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

  // (d) Resolve the gate so the gated run completes (but its store write should be skipped).
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

test('run() sends full history after undo on a chaining provider (Responses API)', async (t) => {
  // Simulate a chaining provider (OpenAI) with a two-turn conversation, then undo.
  const firstStream = new MockStream([{ type: 'response.output_text.delta', delta: 'First reply' }]);
  firstStream.finalOutput = 'First reply';
  firstStream.lastResponseId = 'resp-turn1';
  firstStream.history = [
    { role: 'user', type: 'message', content: 'First message' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'First reply' }],
    },
  ];

  const secondStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Second reply' }]);
  secondStream.finalOutput = 'Second reply';
  secondStream.lastResponseId = 'resp-turn2';
  secondStream.history = [
    { role: 'user', type: 'message', content: 'First message' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'First reply' }],
    },
    { role: 'user', type: 'message', content: 'Second message' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Second reply' }],
    },
  ];

  const afterUndoStream = new MockStream([{ type: 'response.output_text.delta', delta: 'After undo reply' }]);
  afterUndoStream.finalOutput = 'After undo reply';
  afterUndoStream.lastResponseId = 'resp-after-undo';
  afterUndoStream.history = [
    { role: 'user', type: 'message', content: 'First message' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'First reply' }],
    },
    { role: 'user', type: 'message', content: 'Retry message' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'After undo reply' }],
    },
  ];

  const calls = [];
  let callCount = 0;
  const mockClient = {
    getProvider() {
      return 'openai';
    },
    async startStream(input, opts) {
      callCount++;
      calls.push({ input, opts });
      if (callCount === 1) return firstStream;
      if (callCount === 2) return secondStream;
      return afterUndoStream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  // Turn 1: chaining provider sends just the text string
  for await (const _ of session.run('First message')) {
  }
  t.is(typeof calls[0].input, 'string', 'Turn 1: chaining sends just the text');
  t.falsy(calls[0].opts.previousResponseId);

  // Turn 2: chaining provider uses previousResponseId from turn 1
  for await (const _ of session.run('Second message')) {
  }
  t.is(typeof calls[1].input, 'string', 'Turn 2: chaining sends just the text');

  // Undo: removes second user turn, nullifies previousResponseId
  session.undoLastUserTurn();

  // Turn 3 (after undo): must send full history, NOT just the latest message
  for await (const _ of session.run('Retry message')) {
  }
  const thirdCall = calls[2];
  t.true(Array.isArray(thirdCall.input), 'Turn after undo must send full history array');
  t.true(thirdCall.input.length >= 2, 'Full history includes prior turns');
  t.falsy(thirdCall.opts.previousResponseId, 'No previousResponseId after undo');
});

test('run() with image attachment does not throw when supportsChaining is true', async (t) => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Reply' }]);
  stream.finalOutput = 'Reply';

  let receivedInput;
  const mockClient = {
    async startStream(input) {
      receivedInput = input;
      return stream;
    },
    getProvider() {
      return 'openai';
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  const turn = {
    text: 'describe this image',
    images: [
      {
        id: 'img1',
        data: 'base64data',
        mimeType: 'image/png',
        byteSize: 100,
        displayNumber: 1,
      },
    ],
  };

  const emitted = [];
  for await (const ev of session.run(turn)) {
    emitted.push(ev);
  }

  // Under conversation chaining (supportsChaining is true), if it contains an image,
  // it should send the input wrapped in an array, not as a single object, to avoid
  // "originalInput is not iterable" when agents SDK processes it.
  t.true(Array.isArray(receivedInput), 'Input should be wrapped in an array');
  t.is(receivedInput.length, 1);
  t.is(receivedInput[0].role, 'user');
  t.is(receivedInput[0].content[0].type, 'input_text');
  t.is(receivedInput[0].content[1].type, 'input_image');
});

test('previewLargeUncachedInput() does not mutate history', (t) => {
  const mockClient = {
    getProvider() {
      return 'codex';
    },
  };
  const settings = new Map([
    ['agent.model', 'gpt-5'],
    ['agent.provider', 'codex'],
    ['agent.reasoningEffort', 'medium'],
    ['app.planMode', true],
  ]);
  const settingsService = {
    get(key) {
      return settings.get(key);
    },
  };
  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger, settingsService },
  });

  const before = session.exportState();

  const decision = session.previewLargeUncachedInput('hello', 1_000);

  t.is(decision.action, 'allow');
  t.deepEqual(session.exportState(), before);
});

test('sendMessage() records successful large guard state after provider request completion', async (t) => {
  const firstStream = new MockStream([{ type: 'response.output_text.delta', delta: 'ok' }]);
  firstStream.finalOutput = 'ok';
  firstStream.history = [
    { role: 'user', type: 'message', content: 'first' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
  ];

  const mockClient = {
    getProvider() {
      return 'codex';
    },
    async startStream() {
      return firstStream;
    },
  };
  const settings = new Map([
    ['agent.model', 'gpt-5'],
    ['agent.provider', 'codex'],
    ['agent.reasoningEffort', 'medium'],
  ]);
  const settingsService = {
    get(key) {
      return settings.get(key);
    },
  };
  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger, settingsService },
  });

  const large = 'x'.repeat(64_000 * 4);
  t.is(session.previewLargeUncachedInput(large, 1_000).action, 'allow');

  await session.sendMessage(large);

  const decision = session.previewLargeUncachedInput(large, Date.now() + 5 * 60 * 1_000 + 1);
  t.is(decision.action, 'warn');
  t.true(decision.reasons.includes('idle_timeout'));
});

test('run() yields an error event carrying droppedUserMessage when startStream fails pre-stream', async (t) => {
  const mockClient = {
    async startStream() {
      throw new Error('upstream 500');
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  const emitted = [];
  let thrown = null;
  try {
    for await (const ev of session.run('hello')) {
      emitted.push(ev);
    }
  } catch (e) {
    thrown = e;
  }

  // The run wraps the throw inside the catch and re-throws after yielding the
  // error event, but consumer-cleanup may swallow the re-throw — what matters
  // is that the error event carried the drop signal.
  const errorEvent = emitted.find((e) => e.type === 'error');
  t.truthy(errorEvent, 'should emit an error event');
  t.truthy(errorEvent.droppedUserMessage, 'error event should carry droppedUserMessage');
  t.is(errorEvent.droppedUserMessage.text, 'hello');
  t.is(errorEvent.droppedUserMessage.imageCount, 0);

  // And the store should have rolled back the user turn so /undo state is clean.
  t.is(session.listUserTurns().length, 0);
  t.truthy(thrown);
});

test('run() omits droppedUserMessage when no user turn was added (skipUserMessage)', async (t) => {
  const mockClient = {
    async startStream() {
      throw new Error('upstream 500');
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  const emitted = [];
  try {
    for await (const ev of session.run('hello', { skipUserMessage: true })) {
      emitted.push(ev);
    }
  } catch {
    // expected
  }

  const errorEvent = emitted.find((e) => e.type === 'error');
  t.truthy(errorEvent);
  t.is(errorEvent.droppedUserMessage, undefined);
});

test('run() emits user_message_consumed_for_abort when an aborted approval is being resolved', async (t) => {
  // Plant an aborted approval context directly via approvalState so the
  // session's consumeAborted() picks it up. The downstream fake-execution
  // path will throw (no real interruption), but we only care about event order.
  const mockClient = {
    async startStream() {
      throw new Error('not used');
    },
    async continueRunStream() {
      throw new Error('continue not implemented in test');
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  session.approvalState.setPending({
    state: {},
    interruption: { type: 'tool_approval_item', rawItem: { name: 'noop', callId: 'c1' } },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });
  session.approvalState.abortPending();

  const emitted = [];
  try {
    for await (const ev of session.run('follow up text')) {
      emitted.push(ev);
    }
  } catch {
    // expected — downstream paths will fail in this minimal mock
  }

  const idx = emitted.findIndex((e) => e.type === 'user_message_consumed_for_abort');
  t.true(idx >= 0, 'must emit user_message_consumed_for_abort');
  // The store must not have a genuine user turn for this input.
  t.is(session.listUserTurns().length, 0);
});

test('switchProvider() clears provider continuity but preserves transcript history', async (t) => {
  const firstStream = new MockStream([{ type: 'response.output_text.delta', delta: 'First reply' }]);
  firstStream.finalOutput = 'First reply';
  firstStream.lastResponseId = 'resp-openai-1';

  const secondStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Second reply' }]);
  secondStream.finalOutput = 'Second reply';
  secondStream.lastResponseId = 'resp-openrouter-1';

  const calls = [];
  let provider = 'openai';
  let clearConversationsCalls = 0;
  const mockClient = {
    getProvider() {
      return provider;
    },
    setProvider(nextProvider) {
      provider = nextProvider;
    },
    clearConversations() {
      clearConversationsCalls++;
    },
    async startStream(input, opts) {
      calls.push({ input, opts, provider });
      return calls.length === 1 ? firstStream : secondStream;
    },
  };

  const session = new ConversationSession('s1', {
    agentClient: mockClient,
    deps: { logger: mockLogger },
  });

  for await (const _ of session.run('First message')) {
  }

  session.approvalState.setPending({
    state: {},
    interruption: { type: 'tool_approval_item', rawItem: { name: 'noop', callId: 'c1' } },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });
  session.approvalState.abortPending();

  session.switchProvider('openrouter');

  t.is(await session.handleApprovalDecision('y'), null, 'pending approval should be cleared on provider switch');

  const emitted = [];
  for await (const ev of session.run('Second message')) {
    emitted.push(ev);
  }

  t.is(clearConversationsCalls, 1);
  t.is(provider, 'openrouter');
  t.false(
    emitted.some((event) => event.type === 'user_message_consumed_for_abort'),
    'aborted approval state should be cleared on provider switch',
  );

  const secondCall = calls[1];
  t.true(Array.isArray(secondCall.input), 'provider switch should force full-history replay on the next turn');
  t.true(secondCall.input.length >= 2, 'replayed history should include the earlier user turn');
  t.falsy(secondCall.opts.previousResponseId, 'provider switch must discard previousResponseId from the old provider');
  t.deepEqual(
    session.listUserTurns().map((turn) => turn.text),
    ['First message', 'Second message'],
  );
});
