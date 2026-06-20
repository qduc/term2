import { it, expect } from 'vitest';
import { ModelBehaviorError } from '@openai/agents';
import { createConversationSession } from '../../test-helpers/conversation-session-with-adapter.js';
import { MockStream } from '../test-helpers/mock-stream.js';
import {
  mockLogger,
  sessionContextService,
  createMockAgentClient,
} from './test-helpers/conversation-session-fixtures.js';
import type {
  ConversationEvent,
  TextDeltaEvent,
  FinalResponseEvent,
  ToolRecoveryEvent,
  ApprovalRequiredEvent,
  ToolStartedEvent,
  RetryEvent,
} from '../conversation/conversation-events.js';

it('run() streams ConversationEvents (text_delta → final) in order', async () => {
  const events = [
    { type: 'response.output_text.delta', delta: 'Hello' },
    { type: 'response.output_text.delta', delta: ' world' },
  ];

  const stream = new MockStream(events);
  stream.finalOutput = 'Hello world';
  stream.lastResponseId = 'resp-1';

  const mockClient = createMockAgentClient({
    async startStream() {
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  const emitted: ConversationEvent[] = [];
  for await (const ev of turnCoordinator.start('hi')) {
    emitted.push(ev);
  }

  expect(emitted.map((e: ConversationEvent) => e.type)).toEqual(['text_delta', 'text_delta', 'final']);
  expect((emitted[0] as TextDeltaEvent).delta).toBe('Hello');
  expect((emitted[0] as TextDeltaEvent).fullText).toBe('Hello');
  expect((emitted[1] as TextDeltaEvent).delta).toBe(' world');
  expect((emitted[1] as TextDeltaEvent).fullText).toBe('Hello world');
  expect((emitted[2] as FinalResponseEvent).finalText).toBe('Hello world');
});

it('run() warns when completed stream history already contains duplicated tool pairs', async () => {
  const warnings: { message: string; meta?: Record<string, unknown> }[] = [];
  const logger = {
    ...mockLogger,
    warn: (message: string, meta?: Record<string, unknown>) => warnings.push({ message, meta }),
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

  const mockClient = createMockAgentClient({
    async startStream() {
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  for await (const _ev of turnCoordinator.start('hi')) {
    // consume stream
  }
  const warning = warnings.find(
    (entry: { message: string; meta?: Record<string, unknown> }) =>
      entry.meta?.eventType === 'conversation.stream_history.replayed_tools',
  );
  expect(warning).toBeTruthy();
  expect(warning!.meta!.phase as string).toBe('post_stream');
  expect(warning!.meta!.source as string).toBe('startStream');
  expect((warning!.meta! as Record<string, unknown>).historyDuplicatePairs).toBe(1);
  expect((warning!.meta! as Record<string, unknown>).newItemsDuplicatePairs).toBe(1);
  expect((warning!.meta! as Record<string, unknown>).stateGeneratedItemsDuplicatePairs).toBe(1);
  expect('output' in (warning!.meta! as Record<string, unknown>)).toBe(false);
});

it('run() retries streamed recoverable errors without committing failed stream history', async () => {
  class FailingStream extends MockStream {
    constructor() {
      super([]);
      (this as unknown as Record<string, unknown>).history = [
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

  const calls: unknown[] = [];
  const mockClient = createMockAgentClient({
    getProvider() {
      return 'openrouter';
    },
    async startStream(input: unknown) {
      calls.push(input);
      return calls.length === 1 ? new FailingStream() : successStream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
    retryOptions: { allowFreshStartRetries: false },
  });
  const { turnCoordinator } = bundle;

  const emitted: ConversationEvent[] = [];
  for await (const ev of turnCoordinator.start('retry me')) {
    emitted.push(ev);
  }

  expect(emitted.map((event: ConversationEvent) => event.type)).toEqual(['text_delta', 'retry', 'text_delta', 'final']);
  expect(calls.length).toBe(2);
  expect((calls[0] as unknown[]).length).toBe(1);
  expect(calls[1] as unknown as unknown).toEqual([{ role: 'user', type: 'message', content: 'retry me' }]);
});

it('run() does not retry recoverable errors from a fresh start when disabled', async () => {
  let calls = 0;
  const mockClient = createMockAgentClient({
    getProvider() {
      return 'openrouter';
    },
    async startStream() {
      calls++;
      throw new ModelBehaviorError('Tool fake_tool not found in agent Terminal Assistant.');
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
    retryOptions: { allowFreshStartRetries: false },
  });
  const { turnCoordinator } = bundle;

  const emitted: ConversationEvent[] = [];

  await expect(async () => {
    for await (const ev of turnCoordinator.start('retry me')) {
      emitted.push(ev);
    }
  }).rejects.toThrow();

  expect(calls).toBe(1);
  expect(emitted.some((event: ConversationEvent) => event.type === 'retry')).toBe(false);
  expect(emitted.find((event: ConversationEvent) => event.type === 'error')).toBeTruthy();
});

it('run() exports completed tool pairs from a stream that later fails', async () => {
  class FailingStream extends MockStream {
    constructor() {
      super([]);
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

  const mockClient = createMockAgentClient({
    getProvider() {
      return 'openrouter';
    },
    async startStream() {
      return new FailingStream();
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator, stateFacade } = bundle;

  await expect(async () => {
    for await (const _ev of turnCoordinator.start('inspect')) {
      // consume stream
    }
  }).rejects.toThrow();

  const state = stateFacade!.exportState();
  // Reconciled history: user message + completed call/result pair.
  // The aborted second call has no result yet, so it is not pushed into history.
  expect(state.history.length).toBe(3);
  expect(state.toolLedger.length).toBe(2);
  expect((state.toolLedger[0] as unknown as Record<string, unknown>).status).toBe('completed');
  expect((state.toolLedger[1] as unknown as Record<string, unknown>).status).toBe('aborted');
  expect(
    (state.toolLedger[0] as { historyItems: { callId: string }[] }).historyItems.map(
      (item: { callId: string }) => item.callId,
    ),
  ).toEqual(['call-read', 'call-read']);
});

it('run() emits tool_recovery before error when a streamed turn fails after tool activity', async () => {
  class FailingStream extends MockStream {
    constructor() {
      super([]);
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

  const mockClient = createMockAgentClient({
    getProvider() {
      return 'openrouter';
    },
    async startStream() {
      return new FailingStream();
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator, stateFacade } = bundle;

  const emitted: ConversationEvent[] = [];

  await expect(async () => {
    for await (const ev of turnCoordinator.start('inspect')) {
      emitted.push(ev);
    }
  }).rejects.toThrow();

  const recovery = emitted.find((event: ConversationEvent) => event.type === 'tool_recovery') as
    | ToolRecoveryEvent
    | undefined;
  expect(recovery).toBeTruthy();
  expect(recovery!.recoveredCallIds).toEqual(['call-read']);
  expect(recovery!.droppedCallIds).toEqual(['call-write']);
  expect(recovery!.message.includes('Recovered 1 completed')).toBe(true);
  expect(
    emitted.findIndex((event: ConversationEvent) => event.type === 'tool_recovery') <
      emitted.findIndex((event: ConversationEvent) => event.type === 'error'),
  ).toBe(true);
  expect(emitted.map((event: ConversationEvent) => event.type)).toEqual([
    'tool_started',
    'command_message',
    'tool_started',
    'tool_recovery',
    'error',
  ]);

  // Regression: after a mid-stream failure, completed tool call/result pairs
  // captured by the ledger must be reconciled into canonical history so the
  // next turn does not send two consecutive user messages with no tool record.
  const state = stateFacade.exportState();
  const types = state.history.map(
    (item: unknown) =>
      (((item as Record<string, unknown>).rawItem as Record<string, unknown> | undefined)?.type as string) ??
      ((item as Record<string, unknown>).type as string),
  );
  expect(types.includes('function_call')).toBe(true);
  expect(types.includes('function_call_result') || types.includes('function_call_output')).toBe(true);
});

it('importState() reconciles completed ledger pairs into canonical history', () => {
  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: createMockAgentClient(),
    deps: { logger: mockLogger, sessionContextService },
  });
  const { stateFacade } = bundle;

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
  expect(state.history.length).toBe(3);
  expect((state.history[1] as Record<string, unknown>).callId).toBe('call-read');
  expect((state.history[2] as Record<string, unknown>).callId).toBe('call-read');
});

it('run() allows a follow-up after a long non-chaining run expands full history', async () => {
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

  const calls: unknown[] = [];
  const mockClient = createMockAgentClient({
    getProvider() {
      return 'opencode';
    },
    async startStream(input: unknown) {
      calls.push(input);
      return calls.length === 1 ? firstStream : secondStream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator, stateFacade } = bundle;

  stateFacade.importState({
    previousResponseId: null,
    history: [{ role: 'user', type: 'message', content: 'seed' }],
  });

  const first = [];
  for await (const ev of turnCoordinator.start('first')) {
    first.push(ev);
  }

  const second = [];
  for await (const ev of turnCoordinator.start('second')) {
    second.push(ev);
  }

  expect(calls.length).toBe(2);
  expect((calls[0] as unknown[]).length).toBe(2);
  expect((calls[1] as unknown[]).length > 212).toBe(true);
  expect(second.map((event: ConversationEvent) => event.type)).toEqual(['text_delta', 'final']);
});

it('sendMessage() allows a follow-up after a long non-chaining run expands full history', async () => {
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

  const calls: unknown[] = [];
  const mockClient = createMockAgentClient({
    getProvider() {
      return 'opencode';
    },
    async startStream(input: unknown) {
      calls.push(input);
      return calls.length === 1 ? firstStream : secondStream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { terminalAdapter, stateFacade } = bundle;

  stateFacade.importState({
    previousResponseId: null,
    history: [{ role: 'user', type: 'message', content: 'seed' }],
  });

  await terminalAdapter.sendMessage('first');
  const second = await terminalAdapter.sendMessage('second');

  expect((second as unknown as Record<string, unknown>).type).toBe('response');
  expect(calls.length).toBe(2);
  expect((calls[1] as unknown[]).length > 212).toBe(true);
});

it('continue() streams events after approval decision', async () => {
  const interruption = {
    name: 'bash',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo hi' }),
    callId: 'call-xyz',
  };

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  const approveCalls: unknown[] = [];
  const rejectCalls: unknown[] = [];
  initialStream.state = {
    approveCalls,
    rejectCalls,
    approve(arg: unknown) {
      approveCalls.push(arg);
    },
    reject(arg: unknown) {
      rejectCalls.push(arg);
    },
  };

  const continuationStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Approved run' }]);
  continuationStream.finalOutput = 'Approved run';

  const mockClient = createMockAgentClient({
    async startStream() {
      return initialStream;
    },
    async continueRunStream(state: unknown) {
      expect(state).toBe(initialStream.state);
      return continuationStream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  const first = [];
  for await (const ev of turnCoordinator.start('run command')) {
    first.push(ev);
  }
  expect(first.length).toBe(1);
  expect((first[0] as ConversationEvent).type).toBe('approval_required');
  expect((first[0] as ApprovalRequiredEvent).approval.callId).toBe('call-xyz');

  const cont = [];
  for await (const ev of turnCoordinator.continueAfterApproval({ answer: 'y' })) {
    cont.push(ev);
  }

  expect(cont.map((e) => e.type)).toEqual(['tool_started', 'text_delta', 'final']);
  expect((cont[0] as ConversationEvent).type).toBe('tool_started');
  expect((cont[0] as ToolStartedEvent).toolCallId).toBe('call-xyz');
  expect((cont[0] as ToolStartedEvent).toolName).toBe('bash');

  expect((cont[1] as TextDeltaEvent).delta).toBe('Approved run');
  expect((cont[2] as FinalResponseEvent).finalText).toBe('Approved run');
});

it('run() retries malformed tool-call interruption before surfacing approval', async () => {
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
  const mockClient = createMockAgentClient({
    getProvider() {
      return 'openai';
    },
    async startStream() {
      startCalls++;
      return startCalls === 1 ? malformedStream : successStream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  const emitted: ConversationEvent[] = [];
  for await (const ev of turnCoordinator.start('run command')) {
    emitted.push(ev);
  }

  expect(startCalls).toBe(2);
  expect(emitted.map((event: ConversationEvent) => event.type)).toEqual(['retry', 'text_delta', 'final']);
  expect((emitted[0] as RetryEvent).retryType).toBe('parsing_error');
  expect((emitted[emitted.length - 1] as FinalResponseEvent).finalText).toBe('Recovered');
});

it('sendMessage() preserves callId on approval_required terminal result', async () => {
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

  const mockClient = createMockAgentClient({
    async startStream() {
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { terminalAdapter } = bundle;

  const result = await terminalAdapter.sendMessage('run command');
  expect(result.type).toBe('approval_required');
  if (result.type !== 'approval_required') {
    expect(true).toBe(false);
    return;
  }
  expect(result.approval.callId).toBe('call-preserve-1');
});

it('handleApprovalDecision() preserves callId on subsequent approval_required terminal result', async () => {
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
  const approveCalls: unknown[] = [];
  initialStream.state = {
    approveCalls,
    approve(arg: unknown) {
      approveCalls.push(arg);
    },
    reject() {},
  };

  const continuationStream = new MockStream([]);
  continuationStream.interruptions = [secondInterruption];

  const mockClient = createMockAgentClient({
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      return continuationStream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { terminalAdapter } = bundle;

  const first = await terminalAdapter.sendMessage('run command');
  expect(first.type).toBe('approval_required');
  if (first.type !== 'approval_required') {
    expect(true).toBe(false);
    return;
  }
  expect(first.approval.callId).toBe('call-first');

  const second = await terminalAdapter.handleApprovalDecision('y');
  expect(second).toBeTruthy();
  if (second?.type !== 'approval_required') {
    expect(true).toBe(false);
    return;
  }
  expect(second.approval.callId).toBe('call-second');
});
