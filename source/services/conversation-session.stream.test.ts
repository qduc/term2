// @ts-nocheck - Complex mock patterns deferred to follow-up
import test from 'ava';
import { ModelBehaviorError } from '@openai/agents';
import { createConversationSession } from './conversation-session-factory.js';
import { MockStream } from './test-helpers/mock-stream.js';

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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

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

test.skip('run() falls back to standard service tier after flex timeout', async (t) => {
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

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

test.skip('run() emits an ordered transient retry before stream creation', async (t) => {
  const transientError = new Error("We're currently processing too many requests - please try again later.");
  const successStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Recovered' }]);
  successStream.finalOutput = 'Recovered';
  let calls = 0;

  const mockClient = {
    getStreamMaxRetries() {
      return 1;
    },
    async startStream() {
      calls++;
      if (calls === 1) {
        throw transientError;
      }
      return successStream;
    },
  };

  const bundle = createConversationSession({
    sessionId: 'pre-stream-transient-retry',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });

  const emitted = [];
  for await (const event of bundle.session.run('retry me')) {
    emitted.push(event);
  }

  t.deepEqual(
    emitted.map((event) =>
      event.type === 'retry'
        ? {
            type: event.type,
            toolName: event.toolName,
            attempt: event.attempt,
            maxRetries: event.maxRetries,
            retryType: event.retryType,
          }
        : event.type === 'text_delta' || event.type === 'final'
        ? { type: event.type, text: event.type === 'text_delta' ? event.delta : event.finalText }
        : { type: event.type },
    ),
    [
      { type: 'retry', toolName: 'turn', attempt: 1, maxRetries: 1, retryType: 'upstream' },
      { type: 'text_delta', text: 'Recovered' },
      { type: 'final', text: 'Recovered' },
    ],
  );
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
    retryOptions: { allowFreshStartRetries: false },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

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

test('run() does not retry recoverable errors from a fresh start when disabled', async (t) => {
  let calls = 0;
  const mockClient = {
    getProvider() {
      return 'openrouter';
    },
    async startStream() {
      calls++;
      throw new ModelBehaviorError('Tool fake_tool not found in agent Terminal Assistant.');
    },
  };

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
    retryOptions: { allowFreshStartRetries: false },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  const emitted = [];
  await t.throwsAsync(async () => {
    for await (const ev of session.run('retry me')) {
      emitted.push(ev);
    }
  });

  t.is(calls, 1);
  t.false(emitted.some((event) => event.type === 'retry'));
  t.truthy(emitted.find((event) => event.type === 'error'));
});

test.skip('run() retries streamed transient websocket close 1006 by replaying the turn', async (t) => {
  class FailingStream extends MockStream {
    async *[Symbol.asyncIterator]() {
      yield { type: 'response.output_text.delta', delta: 'partial' };
      throw new Error('WebSocket connection closed before response completed (code=1006)');
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  const emitted = [];
  for await (const ev of session.run('retry me')) {
    emitted.push(ev);
  }

  t.deepEqual(
    emitted.map((event) =>
      event.type === 'retry'
        ? {
            type: event.type,
            toolName: event.toolName,
            attempt: event.attempt,
            maxRetries: event.maxRetries,
            retryType: event.retryType,
          }
        : event.type === 'text_delta' || event.type === 'final'
        ? { type: event.type, text: event.type === 'text_delta' ? event.delta : event.finalText }
        : { type: event.type },
    ),
    [
      { type: 'text_delta', text: 'partial' },
      { type: 'retry', toolName: 'turn', attempt: 1, maxRetries: 5, retryType: 'upstream' },
      { type: 'text_delta', text: 'Recovered' },
      { type: 'final', text: 'Recovered' },
    ],
  );
  t.is(emitted[1].retryType, 'upstream');
  t.is(calls.length, 2);
  t.is(calls[0].length, 1);
  t.deepEqual(calls[1], [{ role: 'user', type: 'message', content: 'retry me' }]);
});

test.skip('run() retries non-chaining streamed transient errors from completed tool call history', async (t) => {
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
      throw new Error('WebSocket connection closed before response completed (code=1006)');
    }
  }

  const successStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Recovered' }]);
  successStream.finalOutput = 'Recovered';
  successStream.lastResponseId = 'resp-recovered';
  successStream.history = [
    { role: 'user', type: 'message', content: 'inspect' },
    { type: 'function_call', id: 'fc_1', callId: 'call-read', name: 'read_file', arguments: '{}' },
    { type: 'function_call_result', id: 'fcr_1', callId: 'call-read', name: 'read_file', output: 'contents' },
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Recovered' }] },
  ];

  const followUpStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Follow up' }]);
  followUpStream.finalOutput = 'Follow up';
  followUpStream.lastResponseId = 'resp-follow-up';
  followUpStream.history = [
    ...successStream.history,
    { role: 'user', type: 'message', content: 'follow up' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Follow up' }],
    },
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  const emitted = [];
  for await (const ev of session.run('inspect')) {
    emitted.push(ev);
  }

  t.deepEqual(
    emitted.map((event) => event.type),
    ['tool_started', 'command_message', 'retry', 'text_delta', 'final'],
  );
  t.is(calls.length, 2);
  t.deepEqual(
    calls[1].map((item) => item.type),
    ['message', 'function_call', 'function_call_result'],
  );
  t.deepEqual(
    calls[1].filter((item) => item.role === 'user').map((item) => item.content),
    ['inspect'],
  );
  t.deepEqual(
    calls[1].filter((item) => item.callId === 'call-read').map((item) => item.type),
    ['function_call', 'function_call_result'],
  );

  const state = stateFacade.exportState();
  t.is(state.toolLedger.filter((entry) => entry.callId === 'call-read').length, 1);
  t.is(state.toolLedger.find((entry) => entry.callId === 'call-read').status, 'completed');
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  await t.throwsAsync(async () => {
    for await (const _ev of session.run('inspect')) {
      // consume stream
    }
  });

  const state = stateFacade.exportState();
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

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
  t.deepEqual(
    emitted.map((event) => event.type),
    ['tool_started', 'command_message', 'tool_started', 'tool_recovery', 'error'],
  );

  // Regression: after a mid-stream failure, completed tool call/result pairs
  // captured by the ledger must be reconciled into canonical history so the
  // next turn does not send two consecutive user messages with no tool record.
  const state = stateFacade.exportState();
  const types = state.history.map((item) => item.rawItem?.type ?? item.type);
  t.true(types.includes('function_call'));
  t.true(types.includes('function_call_result') || types.includes('function_call_output'));
});

test('importState() reconciles completed ledger pairs into canonical history', (t) => {
  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: {},
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  stateFacade.importState({
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

  const state = stateFacade.exportState();
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  stateFacade.importState({
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  stateFacade.importState({
    previousResponseId: null,
    history: [{ role: 'user', type: 'message', content: 'seed' }],
  });

  await terminalAdapter.sendMessage('first');
  const second = await terminalAdapter.sendMessage('second');

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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  const first = [];
  for await (const ev of session.run('run command')) {
    first.push(ev);
  }
  t.is(first.length, 1);
  t.is(first[0].type, 'approval_required');
  t.is(first[0].approval.callId, 'call-xyz');

  const cont = [];
  for await (const ev of session.continueAfterApproval({ answer: 'y' })) {
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

test.skip('continue() retries on transient error during stream iteration', async (t) => {
  const interruption = {
    name: 'bash',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo hi' }),
    callId: 'call-retry',
  };

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.lastResponseId = 'resp-initial';
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
  successStream.lastResponseId = 'resp-recovered';

  const followUpStream = new MockStream([{ type: 'response.output_text.delta', delta: 'After continue' }]);
  followUpStream.finalOutput = 'After continue';
  followUpStream.lastResponseId = 'resp-after-continue';

  let continueCalls = 0;
  let startCalls = 0;
  const calls = [];
  const mockClient = {
    getProvider() {
      return 'codex';
    },
    async startStream(input, opts) {
      startCalls++;
      calls.push({ input, opts });
      return startCalls === 1 ? initialStream : followUpStream;
    },
    async continueRunStream(state, opts) {
      continueCalls++;
      calls.push({ state, opts });
      return continueCalls === 1 ? failingStream : successStream;
    },
  };

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  // Trigger approval_required
  const first = [];
  for await (const ev of session.run('run command')) {
    first.push(ev);
  }
  t.is(first[0].type, 'approval_required');

  // Continue — first attempt fails, second succeeds via continueRunStream retry
  const cont = [];
  for await (const ev of session.continueAfterApproval({ answer: 'y' })) {
    cont.push(ev);
  }

  t.is(continueCalls, 2);
  t.is(startCalls, 1);
  t.is(calls[1].opts.previousResponseId, 'resp-initial');
  t.is(calls[2].opts.previousResponseId, 'resp-initial');
  const types = cont.map((e) => e.type);
  t.true(types.includes('retry'), 'should emit a retry event');
  t.true(types.includes('final'), 'should emit a final event after retry');
  t.is(cont[cont.length - 1].finalText, 'Recovered');

  for await (const _ of session.run('after continue')) {
  }

  t.is(startCalls, 2);
  t.is(typeof calls[3].input, 'string', 'successful retry should allow later turns to chain again');
  t.is(calls[3].input, 'after continue');
  t.is(calls[3].opts.previousResponseId, 'resp-recovered');
});

test('run() retries malformed tool-call interruption before surfacing approval', async (t) => {
  const malformedStream = new MockStream([]);
  malformedStream.interruptions = [
    {
      name: 'shell',
      callId: 'call-malformed',
      arguments: '{"command":"echo hi"',
      agent: { name: 'CLI Agent' },
    },
  ];
  malformedStream.state = { approve() {}, reject() {} };

  const successStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Recovered' }]);
  successStream.finalOutput = 'Recovered';
  successStream.lastResponseId = 'resp-recovered';

  let startCalls = 0;
  const mockClient = {
    getProvider() {
      return 'openai';
    },
    async startStream() {
      startCalls++;
      return startCalls === 1 ? malformedStream : successStream;
    },
  };

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  const emitted = [];
  for await (const ev of session.run('run command')) {
    emitted.push(ev);
  }

  t.is(startCalls, 2);
  t.deepEqual(
    emitted.map((event) => event.type),
    ['retry', 'text_delta', 'final'],
  );
  t.is(emitted[0].retryType, 'parsing_error');
  t.is(emitted[emitted.length - 1].finalText, 'Recovered');
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  const result = await terminalAdapter.sendMessage('run command');
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  const first = await terminalAdapter.sendMessage('run command');
  t.is(first.type, 'approval_required');
  t.is(first.approval.callId, 'call-first');

  const second = await terminalAdapter.handleApprovalDecision('y');
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

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

test('run() preserves assistant text prefix when SDK full-history reconstruction strips it', async (t) => {
  const firstStream = new MockStream([{ type: 'response.output_text.delta', delta: 'I will inspect the files.' }]);
  firstStream.finalOutput = 'I will inspect the files.';
  firstStream.output = [];
  firstStream.newItems = [
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'I will inspect the files.' }],
    },
  ];
  firstStream.history = [
    { role: 'user', type: 'message', content: 'Investigate cache issue' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"source/app.tsx"}' },
        },
      ],
    },
  ];

  const secondStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Continuing.' }]);
  secondStream.finalOutput = 'Continuing.';
  secondStream.output = [
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Continuing.' }],
    },
  ];

  const calls = [];
  const mockClient = {
    async startStream(input) {
      calls.push(input);
      return calls.length === 1 ? firstStream : secondStream;
    },
    getProvider() {
      return 'openrouter';
    },
  };

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  for await (const _ of session.run('Investigate cache issue')) {
    // consume events
  }
  for await (const _ of session.run('Continue after max turns')) {
    // consume events
  }

  const secondInput = calls[1];
  t.true(Array.isArray(secondInput));
  t.deepEqual(secondInput.slice(0, 3), [
    { role: 'user', type: 'message', content: 'Investigate cache issue' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'I will inspect the files.' }],
    },
    { role: 'user', type: 'message', content: 'Continue after max turns' },
  ]);
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

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

test('run() chains follow-up turns for Codex provider over websocket', async (t) => {
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  for await (const _ of session.run('First message')) {
    // consume events
  }
  for await (const _ of session.run('Second message')) {
    // consume events
  }

  t.is(typeof calls[0].input, 'string', 'Codex should send only the first user message on turn 1');
  t.falsy(calls[0].opts.previousResponseId, 'Codex should not receive a previousResponseId on turn 1');
  t.is(typeof calls[1].input, 'string', 'Codex should send only the next user message on turn 2');
  t.is(calls[1].input, 'Second message');
  t.is(calls[1].opts.previousResponseId, 'resp-codex-1', 'Codex should chain follow-up turns from turn 1');
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  const result = await terminalAdapter.sendMessage('Hello');

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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  const approvalResult = await terminalAdapter.sendMessage('run command');
  t.is(approvalResult.type, 'approval_required');

  const finalResult = await terminalAdapter.handleApprovalDecision('y');
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  await terminalAdapter.sendMessage('Hello');

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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  await terminalAdapter.sendMessage('Hello');

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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  const result = await terminalAdapter.sendMessage('Hello');
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  const result = await terminalAdapter.sendMessage('Hello');
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  for await (const _ of session.run('hello')) {
    // consume
  }

  const result = stateFacade.undoLastUserTurn();
  t.deepEqual(result, { text: 'hello', imageCount: 0 });
});

test('undoLastUserTurn() returns null when no genuine user turn exists', async (t) => {
  const mockClient = {
    async startStream() {
      return new MockStream([]);
    },
  };

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  const result = stateFacade.undoLastUserTurn();
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

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
  const undone = stateFacade.undoLastUserTurn();
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

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
  stateFacade.undoLastUserTurn();

  // Turn 3 (after undo): must send full history, NOT just the latest message
  for await (const _ of session.run('Retry message')) {
  }
  const thirdCall = calls[2];
  t.true(Array.isArray(thirdCall.input), 'Turn after undo must send full history array');
  t.true(thirdCall.input.length >= 2, 'Full history includes prior turns');
  t.falsy(thirdCall.opts.previousResponseId, 'No previousResponseId after undo');
});

test('run() resyncs full history after resume before returning to chaining provider', async (t) => {
  const firstResumedStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Resynced reply' }]);
  firstResumedStream.finalOutput = 'Resynced reply';
  firstResumedStream.lastResponseId = 'resp-resynced';
  firstResumedStream.history = [
    { role: 'user', type: 'message', content: 'Earlier message' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Earlier reply' }],
    },
    { role: 'user', type: 'message', content: 'Resume follow-up' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Resynced reply' }],
    },
  ];

  const chainedStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Chained reply' }]);
  chainedStream.finalOutput = 'Chained reply';
  chainedStream.lastResponseId = 'resp-chained';
  chainedStream.output = [
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Chained reply' }],
    },
  ];

  const calls = [];
  const streams = [firstResumedStream, chainedStream];
  const mockClient = {
    getProvider() {
      return 'openai';
    },
    async startStream(input, opts) {
      calls.push({ input, opts });
      return streams.shift();
    },
  };

  const bundle = createConversationSession({
    sessionId: 'resumed-session',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;
  stateFacade.importState({
    history: [
      { role: 'user', type: 'message', content: 'Earlier message' },
      {
        role: 'assistant',
        type: 'message',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Earlier reply' }],
      },
    ],
    previousResponseId: 'expired-response-id',
    toolLedger: [],
    updatedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
  });

  for await (const _ of session.run('Resume follow-up')) {
  }
  t.true(Array.isArray(calls[0].input), 'First resumed turn must resend full history');
  t.falsy(calls[0].opts.previousResponseId, 'First resumed turn must not use persisted previousResponseId');
  t.deepEqual(
    calls[0].input.map((item) => item.content),
    ['Earlier message', [{ type: 'output_text', text: 'Earlier reply' }], 'Resume follow-up'],
  );

  for await (const _ of session.run('Second follow-up')) {
  }
  t.is(calls[1].input, 'Second follow-up', 'Second resumed turn should return to delta chaining');
  t.is(calls[1].opts.previousResponseId, 'resp-resynced');
});

test('run() ignores a stale completion after importState() bumps generation', async (t) => {
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  class GatedStream extends MockStream {
    constructor() {
      super([]);
      this.lastResponseId = 'resp-stale';
      this.finalOutput = 'stale reply';
      this.history = [
        { role: 'user', type: 'message', content: 'stale request' },
        {
          role: 'assistant',
          type: 'message',
          status: 'completed',
          content: [{ type: 'output_text', text: 'stale reply' }],
        },
      ];
      this.output = [
        {
          role: 'assistant',
          type: 'message',
          status: 'completed',
          content: [{ type: 'output_text', text: 'stale reply' }],
        },
      ];
    }

    async *[Symbol.asyncIterator]() {
      yield { type: 'response.output_text.delta', delta: 'stale reply' };
      await gate;
    }
  }

  const freshStream = new MockStream([{ type: 'response.output_text.delta', delta: 'fresh reply' }]);
  freshStream.finalOutput = 'fresh reply';
  freshStream.lastResponseId = 'resp-fresh';

  const calls = [];
  const mockClient = {
    getProvider() {
      return 'openai';
    },
    async startStream(input, opts) {
      calls.push({ input, opts });
      return calls.length === 1 ? new GatedStream() : freshStream;
    },
  };

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  const staleEvents = [];
  const staleRun = (async () => {
    for await (const event of session.run('stale request')) {
      staleEvents.push(event);
    }
  })();

  await Promise.resolve();

  stateFacade.importState({
    history: [],
    previousResponseId: null,
    toolLedger: [],
    updatedAt: new Date().toISOString(),
  });

  releaseGate();
  await staleRun;

  t.deepEqual(staleEvents, []);
  t.deepEqual(stateFacade.exportState().history, []);

  for await (const _ of session.run('fresh request')) {
    // consume
  }

  t.is(calls[1].input, 'fresh request');
  t.falsy(calls[1].opts.previousResponseId);
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

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

test('previewLargeUncachedInput() does not mutate history or consume pending mode notice', (t) => {
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
  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, settingsService, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  stateFacade.queueModeNotice('Plan mode enabled');
  const before = stateFacade.exportState();

  const decision = stateFacade.previewLargeUncachedInput('hello', 1_000);

  t.is(decision.action, 'allow');
  t.deepEqual(stateFacade.exportState(), before);
});

test('previewLargeUncachedInput() estimates from outgoing input instead of accepting accumulated session usage overrides', (t) => {
  const mockClient = {
    getProvider() {
      return 'codex';
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
  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, settingsService, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  const large = 'x'.repeat(64_000 * 4);
  const decision = stateFacade.previewLargeUncachedInput(large, 1_000);

  t.is(decision.action, 'allow');
  t.true(decision.estimatedTokens >= 64_000);
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
  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, settingsService, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  const large = 'x'.repeat(64_000 * 4);
  t.is(stateFacade.previewLargeUncachedInput(large, 1_000).action, 'allow');

  await terminalAdapter.sendMessage(large);

  const decision = stateFacade.previewLargeUncachedInput(large, Date.now() + 5 * 60 * 1_000 + 1);
  t.is(decision.action, 'warn');
  t.true(decision.reasons.includes('idle_timeout'));
});

test('run() yields an error event carrying droppedUserMessage when startStream fails pre-stream', async (t) => {
  const mockClient = {
    async startStream() {
      throw new Error('upstream 500');
    },
  };

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

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
  t.is(stateFacade.listUserTurns().length, 0);
  t.truthy(thrown);
});

test('run() omits droppedUserMessage when no user turn was added (skipUserMessage)', async (t) => {
  const mockClient = {
    async startStream() {
      throw new Error('upstream 500');
    },
  };

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  approvalState.setPending({
    state: {},
    interruption: { type: 'tool_approval_item', rawItem: { name: 'noop', callId: 'c1' } },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });
  approvalState.abortPending();

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
  t.is(stateFacade.listUserTurns().length, 0);
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

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  for await (const _ of session.run('First message')) {
  }

  approvalState.setPending({
    state: {},
    interruption: { type: 'tool_approval_item', rawItem: { name: 'noop', callId: 'c1' } },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });
  approvalState.abortPending();

  runtimeController.switchProvider('openrouter');

  t.is(
    await terminalAdapter.handleApprovalDecision('y'),
    null,
    'pending approval should be cleared on provider switch',
  );

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
    stateFacade.listUserTurns().map((turn) => turn.text),
    ['First message', 'Second message'],
  );
});

test('setModel() clears provider continuity and forces full-history replay on the next turn', async (t) => {
  const firstStream = new MockStream([{ type: 'response.output_text.delta', delta: 'First reply' }]);
  firstStream.finalOutput = 'First reply';
  firstStream.lastResponseId = 'resp-model-1';

  const secondStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Second reply' }]);
  secondStream.finalOutput = 'Second reply';
  secondStream.lastResponseId = 'resp-model-2';

  const calls = [];
  const models = [];
  const mockClient = {
    getProvider() {
      return 'openai';
    },
    setModel(model) {
      models.push(model);
    },
    clearConversations() {},
    async startStream(input, opts) {
      calls.push({ input, opts });
      return calls.length === 1 ? firstStream : secondStream;
    },
  };

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  for await (const _ of session.run('First message')) {
  }

  runtimeController.setModel('gpt-next');

  for await (const _ of session.run('Second message')) {
  }

  t.deepEqual(models, ['gpt-next']);
  t.true(Array.isArray(calls[1].input), 'model change should force a full-history replay');
  t.falsy(calls[1].opts.previousResponseId, 'model change must discard previousResponseId');
});

test('undoLastUserTurn() clears tool ledger so stale tool calls are not re-injected on retry', async (t) => {
  // Turn 1: run with a tool call so the tool ledger records an entry.
  const toolCallId = 'call_abc123';
  const turn1Events = [
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId: toolCallId,
          name: 'shell',
          arguments: '{"command":"echo hello"}',
        },
      },
    },
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call_output',
          callId: toolCallId,
          output: 'hello',
        },
      },
    },
    { type: 'response.output_text.delta', delta: 'Done' },
  ];

  const stream1 = new MockStream(turn1Events);
  stream1.finalOutput = 'Done';
  stream1.history = [
    { role: 'user', type: 'message', content: 'run echo hello' },
    {
      type: 'function_call',
      callId: toolCallId,
      name: 'shell',
      arguments: '{"command":"echo hello"}',
    },
    {
      type: 'function_call_output',
      callId: toolCallId,
      output: 'hello',
    },
    {
      role: 'assistant',
      type: 'message',
      content: [{ type: 'output_text', text: 'Done' }],
    },
  ];

  // Turn 2 (after undo + retry): capture what input the model receives.
  let retryInput;
  const stream2 = new MockStream([{ type: 'response.output_text.delta', delta: 'Retried' }]);
  stream2.finalOutput = 'Retried';
  stream2.history = [
    { role: 'user', type: 'message', content: 'run echo hello' },
    {
      role: 'assistant',
      type: 'message',
      content: [{ type: 'output_text', text: 'Retried' }],
    },
  ];

  let callCount = 0;
  const mockClient = {
    getProvider() {
      return 'openrouter';
    },
    async startStream(input) {
      callCount++;
      if (callCount === 1) return stream1;
      retryInput = input;
      return stream2;
    },
  };

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  // Run turn 1 to completion — tool ledger now has the tool call entry.
  for await (const _ of session.run('run echo hello')) {
    // consume
  }

  // Verify ledger has entries before undo.
  const stateBefore = stateFacade.exportState();
  t.true(stateBefore.toolLedger.length > 0, 'tool ledger should have entries before undo');

  // Undo the turn.
  stateFacade.undoLastUserTurn();

  // Verify ledger is cleared after undo.
  const stateAfter = stateFacade.exportState();
  t.is(stateAfter.toolLedger.length, 0, 'tool ledger must be empty after undo');

  // Retry the same message — the model must NOT see the old tool call/result pair.
  for await (const _ of session.run('run echo hello')) {
    // consume
  }

  t.true(Array.isArray(retryInput), 'retry should send full history');
  const callIds = retryInput.filter((item) => item.callId || item.call_id).map((item) => item.callId || item.call_id);
  t.false(callIds.includes(toolCallId), 'retried history must NOT contain old tool call IDs');
});

test('undoLastUserTurn() preserves earlier tool ledger entries that still belong to retained turns', async (t) => {
  const firstToolCallId = 'call_first';
  const secondToolCallId = 'call_second';

  const stream1 = new MockStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId: firstToolCallId,
          name: 'shell',
          arguments: '{"command":"echo first"}',
        },
      },
    },
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call_output',
          callId: firstToolCallId,
          output: 'first',
        },
      },
    },
    { type: 'response.output_text.delta', delta: 'First done' },
  ]);
  stream1.finalOutput = 'First done';
  stream1.lastResponseId = 'resp-first';
  stream1.output = [
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'First done' }],
    },
  ];

  const stream2 = new MockStream([
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call',
          callId: secondToolCallId,
          name: 'shell',
          arguments: '{"command":"echo second"}',
        },
      },
    },
    {
      type: 'run_item_stream_event',
      item: {
        rawItem: {
          type: 'function_call_output',
          callId: secondToolCallId,
          output: 'second',
        },
      },
    },
    { type: 'response.output_text.delta', delta: 'Second done' },
  ]);
  stream2.finalOutput = 'Second done';
  stream2.lastResponseId = 'resp-second';
  stream2.output = [
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Second done' }],
    },
  ];

  let retryInput;
  const retryStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Retry done' }]);
  retryStream.finalOutput = 'Retry done';
  retryStream.lastResponseId = 'resp-retry';
  retryStream.history = [
    { role: 'user', type: 'message', content: 'first tool turn' },
    { type: 'function_call', callId: firstToolCallId, name: 'shell', arguments: '{"command":"echo first"}' },
    { type: 'function_call_output', callId: firstToolCallId, output: 'first' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'First done' }],
    },
    { role: 'user', type: 'message', content: 'retry second turn' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Retry done' }],
    },
  ];

  let callCount = 0;
  const mockClient = {
    getProvider() {
      return 'openai';
    },
    clearConversations() {},
    async startStream(input) {
      callCount++;
      if (callCount === 1) return stream1;
      if (callCount === 2) return stream2;
      retryInput = input;
      return retryStream;
    },
  };

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  for await (const _ of session.run('first tool turn')) {
  }

  for await (const _ of session.run('second tool turn')) {
  }

  stateFacade.undoLastUserTurn();

  const stateAfterUndo = stateFacade.exportState();
  t.deepEqual(
    stateAfterUndo.toolLedger.map((entry) => entry.callId),
    [firstToolCallId],
    'undo should retain tool ledger entries for still-retained earlier turns',
  );

  for await (const _ of session.run('retry second turn')) {
  }

  t.true(Array.isArray(retryInput), 'retry should send full history');
  const retryCallIds = retryInput
    .filter((item) => item.callId || item.call_id)
    .map((item) => item.callId || item.call_id);
  t.true(retryCallIds.includes(firstToolCallId), 'retry should keep earlier retained tool call IDs');
  t.false(retryCallIds.includes(secondToolCallId), 'retry must drop tool call IDs from the undone turn');
});

test.skip('run() retries chaining streamed transient errors by breaking chaining and replaying full history', async (t) => {
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
      throw new Error('WebSocket connection closed before response completed (code=1006)');
    }
  }

  const successStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Recovered' }]);
  successStream.finalOutput = 'Recovered';
  successStream.lastResponseId = 'resp-recovered';
  successStream.history = [
    { role: 'user', type: 'message', content: 'inspect' },
    { type: 'function_call', id: 'fc_1', callId: 'call-read', name: 'read_file', arguments: '{}' },
    { type: 'function_call_result', id: 'fcr_1', callId: 'call-read', name: 'read_file', output: 'contents' },
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Recovered' }] },
  ];

  const followUpStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Follow up' }]);
  followUpStream.finalOutput = 'Follow up';
  followUpStream.lastResponseId = 'resp-follow-up';
  followUpStream.history = [
    ...successStream.history,
    { role: 'user', type: 'message', content: 'follow up' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Follow up' }],
    },
  ];

  const calls = [];
  const mockClient = {
    getProvider() {
      return 'openai';
    },
    async startStream(input, opts) {
      calls.push({ input, opts });
      return calls.length === 1 ? new FailingStream() : calls.length === 2 ? successStream : followUpStream;
    },
  };

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  const emitted = [];
  for await (const ev of session.run('inspect')) {
    emitted.push(ev);
  }

  t.deepEqual(
    emitted.map((event) => event.type),
    ['tool_started', 'command_message', 'retry', 'text_delta', 'final'],
  );
  t.is(calls.length, 2);

  t.is(typeof calls[0].input, 'string');
  t.is(calls[0].input, 'inspect');
  t.falsy(calls[0].opts.previousResponseId);

  t.true(Array.isArray(calls[1].input));
  t.deepEqual(
    calls[1].input.map((item) => item.type),
    ['message', 'function_call', 'function_call_result'],
  );

  for await (const _ of session.run('follow up')) {
  }

  t.is(typeof calls[2].input, 'string', 'successful retry should allow later turns to chain again');
  t.is(calls[2].input, 'follow up');
  t.is(calls[2].opts.previousResponseId, 'resp-recovered');
});

test.skip('run() resumes streamed transient tool continuations with the failed response id', async (t) => {
  const resumeState = { _generatedItems: [] };

  class FailingStream extends MockStream {
    constructor() {
      super([]);
      this.state = resumeState;
      this.lastResponseId = 'resp-current-tool-call';
    }

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
      throw new Error('WebSocket connection closed before response completed (code=1006)');
    }
  }

  const resumedStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Recovered' }]);
  resumedStream.finalOutput = 'Recovered';
  resumedStream.lastResponseId = 'resp-recovered';

  const calls = [];
  const mockClient = {
    getProvider() {
      return 'codex';
    },
    async startStream(input, opts) {
      calls.push({ kind: 'start', input, opts });
      return new FailingStream();
    },
    async continueRunStream(state, opts) {
      calls.push({ kind: 'continue', state, opts });
      return resumedStream;
    },
  };

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  const emitted = [];
  for await (const ev of session.run('inspect')) {
    emitted.push(ev);
  }

  t.is(calls.length, 2);
  t.is(calls[1].kind, 'continue');
  t.is(calls[1].state, resumeState);
  t.is(calls[1].opts.previousResponseId, 'resp-current-tool-call');
  t.deepEqual(
    emitted.map((event) => event.type),
    ['tool_started', 'retry', 'text_delta', 'final'],
  );
});

test.skip('run() forces HTTP fallback after streamed WS retries are exhausted', async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);
  t.teardown(() => {
    globalThis.setTimeout = originalSetTimeout;
  });

  class FailingStream extends MockStream {
    async *[Symbol.asyncIterator]() {
      yield { type: 'response.output_text.delta', delta: 'partial' };
      throw new Error('WebSocket connection closed before response completed');
    }
  }

  const firstStream = new MockStream([{ type: 'response.output_text.delta', delta: 'First response' }]);
  firstStream.finalOutput = 'First response';
  firstStream.lastResponseId = 'resp-first';
  firstStream.history = [
    { role: 'user', type: 'message', content: 'first' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'First response' }],
    },
  ];

  const fallbackStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Recovered over HTTP' }]);
  fallbackStream.finalOutput = 'Recovered over HTTP';
  fallbackStream.lastResponseId = 'resp-http';
  fallbackStream.history = [
    ...firstStream.history,
    { role: 'user', type: 'message', content: 'second' },
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Recovered over HTTP' }],
    },
  ];

  let downgraded = false;
  const calls = [];
  const mockClient = {
    getProvider() {
      return 'codex';
    },
    forceTransportDowngrade() {
      downgraded = true;
      return true;
    },
    async startStream(input, opts) {
      calls.push({ input, opts, transport: downgraded ? 'http' : 'ws' });
      if (calls.length === 1) {
        return firstStream;
      }
      return downgraded ? fallbackStream : new FailingStream();
    },
  };

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { session, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  for await (const _ of session.run('first')) {
    // establish a chained Codex response id
  }

  const emitted = [];
  for await (const event of session.run('second')) {
    emitted.push(event);
  }

  const secondTurnCalls = calls.slice(1);
  t.is(secondTurnCalls.filter((call) => call.transport === 'ws').length, 6);
  t.is(secondTurnCalls.filter((call) => call.transport === 'http').length, 1);

  t.is(typeof secondTurnCalls[0].input, 'string');
  t.is(secondTurnCalls[0].input, 'second');
  t.is(secondTurnCalls[0].opts.previousResponseId, 'resp-first');

  const httpCall = secondTurnCalls[secondTurnCalls.length - 1];
  t.true(Array.isArray(httpCall.input), 'HTTP fallback must replay full history');
  t.falsy(httpCall.opts.previousResponseId, 'HTTP fallback must not use Responses chaining');
  t.deepEqual(
    httpCall.input.filter((item) => item.role === 'user').map((item) => item.content),
    ['first', 'second'],
  );

  t.deepEqual(
    emitted.map((event) => event.type),
    [
      'text_delta',
      'retry',
      'text_delta',
      'retry',
      'text_delta',
      'retry',
      'text_delta',
      'retry',
      'text_delta',
      'retry',
      'text_delta',
      'retry',
      'text_delta',
      'final',
    ],
  );
  t.is(emitted.filter((event) => event.type === 'retry' && event.toolName === 'turn').length, 5);
  t.is(emitted.filter((event) => event.type === 'retry' && event.toolName === 'transport').length, 1);

  const state = stateFacade.exportState();
  const assistantTexts = state.history
    .filter((item) => item.role === 'assistant')
    .flatMap((item) => item.content || [])
    .map((part) => part.text);
  t.deepEqual(assistantTexts, ['First response', 'Recovered over HTTP']);
});
