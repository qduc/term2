import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { ModelBehaviorError } from '@openai/agents';
import type { RunState } from '@openai/agents';
import { createConversationSession } from './session-composition.js';
import { MockStream } from '../test-helpers/mock-stream.js';
import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type {
  ConversationEvent,
  TextDeltaEvent,
  FinalResponseEvent,
  ToolRecoveryEvent,
  ApprovalRequiredEvent,
  ToolStartedEvent,
  UsageUpdateEvent,
  RetryEvent,
} from '../conversation/conversation-events.js';
const createMockAgentClient = (overrides: Record<string, unknown> = {}): ConversationAgentClient =>
  ({
    startStream: async () => new MockStream([]),
    continueRunStream: async () => new MockStream([]),
    abort: () => {},
    setModel: () => {},
    addToolInterceptor: () => () => {},
    chat: async () => '',
    ...overrides,
  } as unknown as ConversationAgentClient);

const mockLogger: ILoggingService = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
};

const sessionContextService: ISessionContextService = {
  runWithContext: (_context, fn) => fn(),
  getContext: () => null,
};

type ClientCall = { input: unknown; opts?: unknown; provider?: string };

const createMockSettingsService = (entries: [string, unknown][] = []): ISettingsService => {
  const settings = new Map(entries);
  return { get: <T>(key: string): T => settings.get(key) as T, set: () => {} };
};

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

it('run() sends text for OpenAI provider (server-side state)', async () => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';

  let receivedInput: unknown;
  const mockClient = createMockAgentClient({
    async startStream(input: unknown) {
      receivedInput = input;
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
  for await (const ev of turnCoordinator.start('Hello')) {
    emitted.push(ev);
  }

  // OpenAI should receive just the text string (no getProvider means default 'openai')
  expect(typeof receivedInput).toBe('string');
  expect(receivedInput).toBe('Hello');
  expect((emitted[emitted.length - 1] as ConversationEvent).type).toBe('final');
});

it('run() sends full history for non-OpenAI providers (client-side state)', async () => {
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

  let receivedInput: unknown;
  const mockClient = createMockAgentClient({
    async startStream(input: unknown) {
      receivedInput = input;
      return stream;
    },
    getProvider() {
      return 'openrouter'; // Non-OpenAI provider
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  const emitted: ConversationEvent[] = [];
  for await (const ev of turnCoordinator.start('Hello')) {
    emitted.push(ev);
  }

  // Non-OpenAI providers should receive full history array
  expect(Array.isArray(receivedInput)).toBe(true);
  expect((receivedInput as unknown[]).length).toBe(1); // Initial user message
  expect((receivedInput as Record<string, unknown>[])[0].role).toBe('user');
  expect((receivedInput as Record<string, unknown>[])[0].content).toBe('Hello');
  expect((emitted[emitted.length - 1] as ConversationEvent).type).toBe('final');
});

it('run() preserves assistant text prefix when SDK full-history reconstruction strips it', async () => {
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

  const calls: unknown[] = [];
  const mockClient = createMockAgentClient({
    async startStream(input: unknown) {
      calls.push(input);
      return calls.length === 1 ? firstStream : secondStream;
    },
    getProvider() {
      return 'openrouter';
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  for await (const _ of turnCoordinator.start('Investigate cache issue')) {
    // consume events
  }
  for await (const _ of turnCoordinator.start('Continue after max turns')) {
    // consume events
  }
  const secondInput = calls[1] as unknown[];
  expect(Array.isArray(secondInput)).toBe(true);
  expect(secondInput.slice(0, 3)).toEqual([
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

it('run() sends full history for openai-compatible providers', async () => {
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

  let firstInput: unknown, secondInput: unknown;
  let callCount = 0;
  const mockClient = createMockAgentClient({
    async startStream(input: unknown) {
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
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  // First message
  for await (const _ of turnCoordinator.start('First message')) {
    // consume events
  }
  // OpenAI-compatible provider should receive full history array
  expect(Array.isArray(firstInput)).toBe(true);
  expect((firstInput as unknown[]).length).toBe(1);
  expect((firstInput as Record<string, unknown>[])[0].content).toBe('First message');

  // Second message should contain both previous and new message
  for await (const _ of turnCoordinator.start('Second message')) {
    // consume events
  }
  expect(Array.isArray(secondInput)).toBe(true);
  expect((secondInput as unknown[]).length >= 2).toBe(true);
});

it('run() chains follow-up turns for Codex provider over websocket', async () => {
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

  const calls: ClientCall[] = [];
  const mockClient = createMockAgentClient({
    async startStream(input: unknown, opts?: unknown) {
      calls.push({ input, opts });
      return calls.length === 1 ? firstStream : secondStream;
    },
    getProvider() {
      return 'codex';
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  for await (const _ of turnCoordinator.start('First message')) {
    // consume events
  }
  for await (const _ of turnCoordinator.start('Second message')) {
    // consume events
  }
  const firstCodexCall = calls[0] as { input: unknown; opts: Record<string, unknown> };
  expect(typeof firstCodexCall.input, 'Codex should send only the first user message on turn 1').toBe('string');
  expect(firstCodexCall.opts.previousResponseId).toBeFalsy();
  const secondCodexCall = calls[1] as { input: unknown; opts: Record<string, unknown> };
  expect(typeof secondCodexCall.input, 'Codex should send only the next user message on turn 2').toBe('string');
  expect(secondCodexCall.input).toBe('Second message');
  expect(secondCodexCall.opts.previousResponseId, 'Codex should chain follow-up turns from turn 1').toBe(
    'resp-codex-1',
  );
});

it('sendMessage() returns usage from final event', async () => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';
  stream.completed = Promise.resolve({
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
  });

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

  const result = await terminalAdapter.sendMessage('Hello');

  expect((result as unknown as Record<string, unknown>).type).toBe('response');
  expect((result as unknown as Record<string, unknown>).usage).toEqual({
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
  });
});

it('handleApprovalDecision() returns usage from final event', async () => {
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

  const approvalResult = await terminalAdapter.sendMessage('run command');
  expect((approvalResult as unknown as Record<string, unknown>).type).toBe('approval_required');

  const finalResult = await terminalAdapter.handleApprovalDecision('y');
  expect((finalResult as unknown as Record<string, unknown>).type).toBe('response');
  expect((finalResult as unknown as Record<string, unknown>).usage).toEqual({
    prompt_tokens: 21,
    completion_tokens: 9,
    total_tokens: 30,
  });
});

it('sendMessage() logs usage handoff at DEBUG level', async () => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';
  stream.completed = Promise.resolve({
    usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
  });

  const debugLogs: { message: string; meta?: unknown }[] = [];
  const logger = {
    ...mockLogger,
    debug: (message: string, meta?: unknown) => {
      debugLogs.push({ message, meta });
    },
  };

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
  const { terminalAdapter } = bundle;

  await terminalAdapter.sendMessage('Hello');

  const hasUsageReturnLog = debugLogs.some(
    (log) =>
      log.message === 'sendMessage returning response' &&
      (log.meta as Record<string, unknown> | undefined)?.hasUsage === true,
  );
  expect(hasUsageReturnLog).toBe(true);
});

it('logs diagnostics when usage is missing in stream completion', async () => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';
  stream.completed = Promise.resolve({ foo: 'bar' });

  const debugLogs: { message: string; meta?: unknown }[] = [];
  const logger = {
    ...mockLogger,
    debug: (message: string, meta?: unknown) => {
      debugLogs.push({ message, meta });
    },
  };

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
  const { terminalAdapter } = bundle;

  await terminalAdapter.sendMessage('Hello');

  const missingUsageLog = debugLogs.find((log) => log.message === 'No usage found in stream completion');
  expect(missingUsageLog).toBeTruthy();
  expect(
    Array.isArray((missingUsageLog as { message: string; meta?: Record<string, unknown> }).meta?.completedResultKeys),
  ).toBe(true);
});

it('sendMessage() extracts usage from stream.rawResponses when completed is void', async () => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Response' }]);
  stream.finalOutput = 'Response';
  stream.completed = Promise.resolve(undefined);
  (stream as unknown as Record<string, unknown>).rawResponses = [
    { usage: { inputTokens: 13, outputTokens: 8, totalTokens: 21 } },
  ];

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

  const result = await terminalAdapter.sendMessage('Hello');
  expect((result as unknown as Record<string, unknown>).type).toBe('response');
  expect((result as unknown as Record<string, unknown>).usage).toEqual({
    prompt_tokens: 13,
    completion_tokens: 8,
    total_tokens: 21,
  });
});

it('sendMessage() preserves cache usage from streaming events when final usage omits it', async () => {
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

  const stream = new MockStream(events);
  stream.completed = Promise.resolve({
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  });

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

  const result = await terminalAdapter.sendMessage('Hello');
  expect((result as unknown as Record<string, unknown>).type).toBe('response');
  expect((result as unknown as Record<string, unknown>).usage).toEqual({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    cache_read_tokens: 60,
  });
});

it('run() emits usage_update when usage is nested in event.data (raw_model_stream_event)', async () => {
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

  const usageEvents = emitted.filter((e: ConversationEvent) => e.type === 'usage_update');
  expect(usageEvents.length >= 1).toBe(true);
  expect((usageEvents[0] as UsageUpdateEvent).usage.prompt_tokens).toBe(50);
  expect((usageEvents[0] as UsageUpdateEvent).usage.completion_tokens).toBe(25);
  expect((usageEvents[0] as UsageUpdateEvent).usage.total_tokens).toBe(75);
});

it('run() emits usage_update when raw model stream usage is nested in event.data.event', async () => {
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

  const usageEvents = emitted.filter((e: ConversationEvent) => e.type === 'usage_update');
  expect(usageEvents.length >= 1).toBe(true);
  expect((usageEvents[0] as UsageUpdateEvent).usage.prompt_tokens).toBe(8);
  expect((usageEvents[0] as UsageUpdateEvent).usage.completion_tokens).toBe(3);
  expect((usageEvents[0] as UsageUpdateEvent).usage.total_tokens).toBe(11);
});

it('run() emits usage_update when usage is at top level of event', async () => {
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

  const usageEvents = emitted.filter((e: ConversationEvent) => e.type === 'usage_update');
  expect(usageEvents.length >= 1).toBe(true);
  expect((usageEvents[0] as UsageUpdateEvent).usage.prompt_tokens).toBe(100);
  expect((usageEvents[0] as UsageUpdateEvent).usage.completion_tokens).toBe(50);
  expect((usageEvents[0] as UsageUpdateEvent).usage.total_tokens).toBe(150);
});

it('undoLastUserTurn() returns { text, imageCount: 0 } after a completed run', async () => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Reply' }]);
  stream.finalOutput = 'Reply';
  stream.history = [
    { role: 'user', type: 'message', content: 'hello' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Reply' }] },
  ];

  const mockClient = createMockAgentClient({
    async startStream() {
      return stream;
    },
    getProvider() {
      return 'openrouter';
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator, stateFacade } = bundle;

  for await (const _ of turnCoordinator.start('hello')) {
    // consume
  }
  const result = stateFacade.undoLastUserTurn();
  expect(result).toEqual({ text: 'hello', imageCount: 0 });
});

it('undoLastUserTurn() returns null when no genuine user turn exists', async () => {
  const mockClient = createMockAgentClient({
    async startStream() {
      return new MockStream([]);
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { stateFacade } = bundle;

  const result = stateFacade.undoLastUserTurn();
  expect(result).toBe(null);
});

it('generation guard: gated run store write is skipped after undoLastUserTurn', async () => {
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
      (this as unknown as Record<string, unknown>).lastResponseId = 'resp_gated';
      (this as unknown as Record<string, unknown>).interruptions = [];
      (this as unknown as Record<string, unknown>).state = {};
      (this as unknown as Record<string, unknown>).newItems = [];
      (this as unknown as Record<string, unknown>).history = [
        { role: 'user', type: 'message', content: 'msg2' },
        { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Reply2' }] },
      ];

      (this as unknown as Record<string, unknown>).finalOutput = 'Reply2';
    }

    async *[Symbol.asyncIterator]() {
      yield { type: 'response.output_text.delta', delta: 'Reply2' };
      await gate;
    }
  }

  // Turn 3: capture the input so we can assert the history array.
  let msg3Input: unknown;
  const stream3 = new MockStream([{ type: 'response.output_text.delta', delta: 'Reply3' }]);
  stream3.finalOutput = 'Reply3';
  stream3.history = [
    { role: 'user', type: 'message', content: 'msg1' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Reply1' }] },
    { role: 'user', type: 'message', content: 'msg3' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Reply3' }] },
  ];

  let callCount = 0;
  const mockClient = createMockAgentClient({
    async startStream(input: unknown) {
      callCount++;
      if (callCount === 1) return stream1;
      if (callCount === 2) return new GatedStream();
      msg3Input = input;
      return stream3;
    },
    getProvider() {
      return 'openrouter';
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator, stateFacade } = bundle;

  // (a) Run msg1 to completion — store now has msg1 + Reply1.
  for await (const _ of turnCoordinator.start('msg1')) {
    // consume
  }
  // (b) Begin msg2 in a background IIFE — it will block on the gate.
  const msg2Done = (async () => {
    const events = [];
    for await (const ev of turnCoordinator.start('msg2')) {
      events.push(ev);
    }
    return events;
  })();

  // Give the IIFE a chance to start and reach the gate (one microtask tick is enough).
  await Promise.resolve();

  // (c) While msg2 is gated, undo it — bumps generation.
  const undone = stateFacade.undoLastUserTurn();
  expect(undone).toMatchObject({ text: 'msg2' });

  // (d) Resolve the gate so the gated run completes (but its store write should be skipped).
  (gateResolve as unknown as () => void)();
  await msg2Done;

  // (e) Issue msg3 and capture the input passed to startStream.
  for await (const _ of turnCoordinator.start('msg3')) {
    // consume
  }
  // The input to startStream for msg3 must contain msg1 but NOT msg2.
  expect(Array.isArray(msg3Input), 'msg3 should receive history array').toBe(true);
  const contents = (msg3Input as Record<string, unknown>[]).map((item: Record<string, unknown>) => item.content);
  expect(contents.includes('msg1'), 'history should contain msg1').toBe(true);
  expect(contents.includes('msg2'), 'history must NOT contain msg2 (generation guard worked)').toBe(false);
});

it('run() throws AbortError when the stream is cancelled/aborted', async () => {
  const stream = new MockStream([]);
  (stream as unknown as Record<string, unknown>).cancelled = true;

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

  await expect(async () => {
    for await (const _ of turnCoordinator.start('hi')) {
      void _;
    }
  }).rejects.toThrow();
});

it('run() sends full history after undo on a chaining provider (Responses API)', async () => {
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

  const calls: ClientCall[] = [];
  let callCount = 0;
  const mockClient = createMockAgentClient({
    getProvider() {
      return 'openai';
    },
    async startStream(input: unknown, opts?: unknown) {
      callCount++;
      calls.push({ input, opts });
      if (callCount === 1) return firstStream;
      if (callCount === 2) return secondStream;
      return afterUndoStream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator, stateFacade } = bundle;

  // Turn 1: chaining provider sends just the text string
  for await (const _ of turnCoordinator.start('First message')) {
  }
  const firstChainCall = calls[0] as { input: unknown; opts: Record<string, unknown> };
  expect(typeof firstChainCall.input).toBe('string'); // was: t.is(typeof firstChainCall.input, 'string', 'Turn 1: chaining sends just the text')
  expect(firstChainCall.opts.previousResponseId).toBeFalsy();

  // Turn 2: chaining provider uses previousResponseId from turn 1
  for await (const _ of turnCoordinator.start('Second message')) {
  }
  const secondChainCall = calls[1] as { input: unknown; opts: Record<string, unknown> };
  expect(typeof secondChainCall.input).toBe('string'); // was: t.is(typeof secondChainCall.input, 'string', 'Turn 2: chaining sends just the text')

  // Undo: removes second user turn, nullifies previousResponseId
  stateFacade.undoLastUserTurn();

  // Turn 3 (after undo): must send full history, NOT just the latest message
  for await (const _ of turnCoordinator.start('Retry message')) {
  }
  const thirdCall = calls[2] as { input: unknown[]; opts: Record<string, unknown> };
  expect(Array.isArray(thirdCall.input), 'Turn after undo must send full history array').toBe(true);
  expect(thirdCall.input.length >= 2, 'Full history includes prior turns').toBe(true);
  expect(thirdCall.opts.previousResponseId, 'No previousResponseId after undo').toBeFalsy();
});

it('run() resyncs full history after resume before returning to chaining provider', async () => {
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

  const calls: unknown[] = [];
  const streams = [firstResumedStream, chainedStream];
  const mockClient = createMockAgentClient({
    getProvider() {
      return 'openai';
    },
    async startStream(input: unknown, opts?: unknown) {
      calls.push({ input, opts });
      return streams.shift();
    },
  });

  const bundle = createConversationSession({
    sessionId: 'resumed-session',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator, stateFacade } = bundle;
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

  for await (const _ of turnCoordinator.start('Resume follow-up')) {
  }
  const firstResumeCall = calls[0] as { input: { content: unknown }[]; opts: Record<string, unknown> };
  expect(Array.isArray(firstResumeCall.input), 'First resumed turn must resend full history').toBe(true);
  expect(
    firstResumeCall.opts.previousResponseId,
    'First resumed turn must not use persisted previousResponseId',
  ).toBeFalsy();
  expect(firstResumeCall.input.map((item) => item.content)).toEqual([
    'Earlier message',
    [{ type: 'output_text', text: 'Earlier reply' }],
    'Resume follow-up',
  ]);

  for await (const _ of turnCoordinator.start('Second follow-up')) {
  }
  const secondResumeCall = calls[1] as { input: unknown; opts: Record<string, unknown> };
  expect(secondResumeCall.input).toBe('Second follow-up'); // was: t.is(secondResumeCall.input, 'Second follow-up', 'Second resumed turn should return to delta chaining')
  expect(secondResumeCall.opts.previousResponseId).toBe('resp-resynced');
});

it('run() ignores a stale completion after importState() bumps generation', async () => {
  let releaseGate: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  class GatedStream extends MockStream {
    constructor() {
      super([]);
      (this as unknown as Record<string, unknown>).lastResponseId = 'resp-stale';
      (this as unknown as Record<string, unknown>).finalOutput = 'stale reply';
      (this as unknown as Record<string, unknown>).history = [
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

  const calls: ClientCall[] = [];
  const mockClient = createMockAgentClient({
    getProvider() {
      return 'openai';
    },
    async startStream(input: unknown, opts?: unknown) {
      calls.push({ input, opts });
      return calls.length === 1 ? new GatedStream() : freshStream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator, stateFacade } = bundle;

  const staleEvents: ConversationEvent[] = [];
  const staleRun = (async () => {
    for await (const event of turnCoordinator.start('stale request')) {
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

  releaseGate!();
  await staleRun;

  expect(staleEvents).toEqual([]);
  expect(stateFacade.exportState().history).toEqual([]);

  for await (const _ of turnCoordinator.start('fresh request')) {
    // consume
  }
  const freshCall = calls[1] as { input: unknown; opts: Record<string, unknown> };
  expect(freshCall.input).toBe('fresh request');
  expect(freshCall.opts.previousResponseId).toBeFalsy();
});

it('run() with image attachment does not throw when supportsChaining is true', async () => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Reply' }]);
  stream.finalOutput = 'Reply';

  let receivedInput: unknown;
  const mockClient = createMockAgentClient({
    async startStream(input: unknown) {
      receivedInput = input;
      return stream;
    },
    getProvider() {
      return 'openai';
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

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

  const emitted: ConversationEvent[] = [];
  for await (const ev of turnCoordinator.start(turn)) {
    emitted.push(ev);
  }

  // Under conversation chaining (supportsChaining is true), if it contains an image,
  // it should send the input wrapped in an array, not as a single object, to avoid
  // "originalInput is not iterable" when agents SDK processes it.
  expect(Array.isArray(receivedInput), 'Input should be wrapped in an array').toBe(true);
  expect((receivedInput as unknown[]).length).toBe(1);
  const firstReceived = (receivedInput as Record<string, unknown>[])[0];
  expect(firstReceived.role).toBe('user');
  const receivedContent = firstReceived.content as { type: string }[];
  expect(receivedContent[0].type).toBe('input_text');
  expect(receivedContent[1].type).toBe('input_image');
});

it('previewLargeUncachedInput() does not mutate history or consume pending mode notice', () => {
  const mockClient = createMockAgentClient({
    getProvider() {
      return 'codex';
    },
  });
  const settingsService = createMockSettingsService([
    ['agent.model', 'gpt-5'],
    ['agent.provider', 'codex'],
    ['agent.reasoningEffort', 'medium'],
    ['app.planMode', true],
  ]);
  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, settingsService, sessionContextService },
  });
  const { stateFacade } = bundle;

  stateFacade.queueModeNotice('Plan mode enabled');
  const before = stateFacade.exportState();

  const decision = stateFacade.previewLargeUncachedInput('hello', 1_000);

  expect(decision.action).toBe('allow');
  expect(stateFacade.exportState()).toEqual(before);
});

it('previewLargeUncachedInput() estimates from outgoing input instead of accepting accumulated session usage overrides', () => {
  const mockClient = createMockAgentClient({
    getProvider() {
      return 'codex';
    },
  });
  const settingsService = createMockSettingsService([
    ['agent.model', 'gpt-5'],
    ['agent.provider', 'codex'],
    ['agent.reasoningEffort', 'medium'],
  ]);
  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, settingsService, sessionContextService },
  });
  const { stateFacade } = bundle;

  const large = 'x'.repeat(64_000 * 4);
  const decision = stateFacade.previewLargeUncachedInput(large, 1_000);

  expect(decision.action).toBe('allow');
  expect(decision.estimatedTokens >= 64_000).toBe(true);
});

it('sendMessage() records successful large guard state after provider request completion', async () => {
  const firstStream = new MockStream([{ type: 'response.output_text.delta', delta: 'ok' }]);
  firstStream.finalOutput = 'ok';
  firstStream.history = [
    { role: 'user', type: 'message', content: 'first' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
  ];

  const mockClient = createMockAgentClient({
    getProvider() {
      return 'codex';
    },
    async startStream() {
      return firstStream;
    },
  });
  const settingsService = createMockSettingsService([
    ['agent.model', 'gpt-5'],
    ['agent.provider', 'codex'],
    ['agent.reasoningEffort', 'medium'],
  ]);
  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, settingsService, sessionContextService },
  });
  const { terminalAdapter, stateFacade } = bundle;

  const large = 'x'.repeat(64_000 * 4);
  expect(stateFacade.previewLargeUncachedInput(large, 1_000).action).toBe('allow');

  await terminalAdapter.sendMessage(large);

  const decision = stateFacade.previewLargeUncachedInput(large, Date.now() + 5 * 60 * 1_000 + 1);
  expect(decision.action).toBe('warn');
  expect(decision.reasons.includes('idle_timeout')).toBe(true);
});

it('run() yields an error event carrying droppedUserMessage when startStream fails pre-stream', async () => {
  const mockClient = createMockAgentClient({
    async startStream() {
      throw new Error('upstream 500');
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator, stateFacade } = bundle;

  const emitted: ConversationEvent[] = [];
  let thrown = null;
  try {
    for await (const ev of turnCoordinator.start('hello')) {
      emitted.push(ev);
    }
  } catch (e) {
    thrown = e;
  }

  // The run wraps the throw inside the catch and re-throws after yielding the
  // error event, but consumer-cleanup may swallow the re-throw — what matters
  // is that the error event carried the drop signal.
  const errorEvent = emitted.find((e: ConversationEvent) => e.type === 'error');
  expect(errorEvent, 'should emit an error event').toBeTruthy();
  if (!errorEvent) {
    throw new Error('expected an error event');
    return;
  }
  expect(errorEvent.droppedUserMessage, 'error event should carry droppedUserMessage').toBeTruthy();
  expect(errorEvent.droppedUserMessage!.text).toBe('hello');
  expect(errorEvent.droppedUserMessage!.imageCount).toBe(0);

  // And the store should have rolled back the user turn so /undo state is clean.
  expect(stateFacade.listUserTurns().length).toBe(0);
  expect(thrown).toBeTruthy();
});

it('run() omits droppedUserMessage when no user turn was added (skipUserMessage)', async () => {
  const mockClient = createMockAgentClient({
    async startStream() {
      throw new Error('upstream 500');
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator } = bundle;

  const emitted: ConversationEvent[] = [];
  try {
    for await (const ev of turnCoordinator.start('hello', { skipUserMessage: true })) {
      emitted.push(ev);
    }
  } catch {
    // expected
  }
  const errorEvent = emitted.find((e: ConversationEvent) => e.type === 'error');
  expect(errorEvent).toBeTruthy();
  if (!errorEvent) {
    throw new Error('expected an error event');
    return;
  }
  expect(errorEvent.droppedUserMessage).toBe(undefined);
});

it('run() emits user_message_consumed_for_abort when an aborted approval is being resolved', async () => {
  // Plant an aborted approval context directly via approvalState so the
  // session's consumeAborted() picks it up. The downstream fake-execution
  // path will throw (no real interruption), but we only care about event order.
  const mockClient = createMockAgentClient({
    async startStream() {
      throw new Error('not used');
    },
    async continueRunStream() {
      throw new Error('continue not implemented in test');
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator, stateFacade, approvalState } = bundle;

  approvalState.setPending({
    state: {} as RunState<any, any>,
    interruption: { type: 'tool_approval_item', rawItem: { name: 'noop', callId: 'c1' } },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });
  approvalState.abortPending();

  const emitted: ConversationEvent[] = [];
  try {
    for await (const ev of turnCoordinator.start('follow up text')) {
      emitted.push(ev);
    }
  } catch {
    // expected — downstream paths will fail in this minimal mock
  }
  const idx = emitted.findIndex((e: ConversationEvent) => e.type === 'user_message_consumed_for_abort');
  expect(idx >= 0).toBe(true);
  // The store must not have a genuine user turn for this input.
  expect(stateFacade.listUserTurns().length).toBe(0);
});

it('switchProvider() clears provider continuity but preserves transcript history', async () => {
  const firstStream = new MockStream([{ type: 'response.output_text.delta', delta: 'First reply' }]);
  firstStream.finalOutput = 'First reply';
  firstStream.lastResponseId = 'resp-openai-1';

  const secondStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Second reply' }]);
  secondStream.finalOutput = 'Second reply';
  secondStream.lastResponseId = 'resp-openrouter-1';

  const calls: ClientCall[] = [];
  let provider = 'openai';
  let clearConversationsCalls = 0;
  const mockClient = createMockAgentClient({
    getProvider() {
      return provider;
    },
    setProvider(nextProvider: string) {
      provider = nextProvider;
    },
    clearConversations() {
      clearConversationsCalls++;
    },
    async startStream(input: unknown, opts?: unknown) {
      calls.push({ input, opts, provider });
      return calls.length === 1 ? firstStream : secondStream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator, terminalAdapter, stateFacade, runtimeController, approvalState } = bundle;

  for await (const _ of turnCoordinator.start('First message')) {
  }

  approvalState.setPending({
    state: {} as RunState<any, any>,
    interruption: { type: 'tool_approval_item', rawItem: { name: 'noop', callId: 'c1' } },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });
  approvalState.abortPending();

  runtimeController.switchProvider('openrouter');

  expect(
    await terminalAdapter.handleApprovalDecision('y'),
    'pending approval should be cleared on provider switch',
  ).toBe(null);

  const emitted: ConversationEvent[] = [];
  for await (const ev of turnCoordinator.start('Second message')) {
    emitted.push(ev);
  }

  expect(clearConversationsCalls).toBe(1);
  expect(provider).toBe('openrouter');
  expect(emitted.some((event: ConversationEvent) => event.type === 'user_message_consumed_for_abort')).toBe(false);

  const secondCall = calls[1] as { input: unknown[]; opts: Record<string, unknown> };
  expect(Array.isArray(secondCall.input)).toBe(true);
  expect(secondCall.input.length >= 2).toBe(true);
  expect(secondCall.opts.previousResponseId).toBeFalsy();
  expect(stateFacade.listUserTurns().map((turn) => turn.text)).toEqual(['First message', 'Second message']);
});

it('setModel() clears provider continuity and forces full-history replay on the next turn', async () => {
  const firstStream = new MockStream([{ type: 'response.output_text.delta', delta: 'First reply' }]);
  firstStream.finalOutput = 'First reply';
  firstStream.lastResponseId = 'resp-model-1';

  const secondStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Second reply' }]);
  secondStream.finalOutput = 'Second reply';
  secondStream.lastResponseId = 'resp-model-2';

  const calls: ClientCall[] = [];
  const models: string[] = [];
  const mockClient = createMockAgentClient({
    getProvider() {
      return 'openai';
    },
    setModel(model: string) {
      models.push(model);
    },
    clearConversations() {},
    async startStream(input: unknown, opts?: unknown) {
      calls.push({ input, opts });
      return calls.length === 1 ? firstStream : secondStream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator, runtimeController } = bundle;

  for await (const _ of turnCoordinator.start('First message')) {
  }

  runtimeController.setModel('gpt-next');

  for await (const _ of turnCoordinator.start('Second message')) {
  }

  expect(models).toEqual(['gpt-next']);
  const secondCall = calls[1] as { input: unknown[]; opts: Record<string, unknown> };
  expect(Array.isArray(secondCall.input)).toBe(true);
  expect(secondCall.opts.previousResponseId).toBeFalsy();
});

it('undoLastUserTurn() clears tool ledger so stale tool calls are not re-injected on retry', async () => {
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
  let retryInput: unknown;
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
  const mockClient = createMockAgentClient({
    getProvider() {
      return 'openrouter';
    },
    async startStream(input: unknown) {
      callCount++;
      if (callCount === 1) return stream1;
      retryInput = input;
      return stream2;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator, stateFacade } = bundle;

  // Run turn 1 to completion — tool ledger now has the tool call entry.
  for await (const _ of turnCoordinator.start('run echo hello')) {
    // consume
  }
  // Verify ledger has entries before undo.
  const stateBefore = stateFacade.exportState();
  expect(stateBefore.toolLedger.length > 0).toBe(true);

  // Undo the turn.
  stateFacade.undoLastUserTurn();

  // Verify ledger is cleared after undo.
  const stateAfter = stateFacade.exportState();
  expect(stateAfter.toolLedger.length, 'tool ledger must be empty after undo').toBe(0);

  // Retry the same message — the model must NOT see the old tool call/result pair.
  for await (const _ of turnCoordinator.start('run echo hello')) {
    // consume
  }
  expect(Array.isArray(retryInput)).toBe(true);
  const callIds = (retryInput as Record<string, unknown>[])
    .filter((item: Record<string, unknown>) => item.callId || item.call_id)
    .map((item: Record<string, unknown>) => item.callId || item.call_id);
  expect(callIds.includes(toolCallId)).toBe(false);
});

it('undoLastUserTurn() preserves earlier tool ledger entries that still belong to retained turns', async () => {
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

  let retryInput: unknown;
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
  const mockClient = createMockAgentClient({
    getProvider() {
      return 'openai';
    },
    clearConversations() {},
    async startStream(input: unknown) {
      callCount++;
      if (callCount === 1) return stream1;
      if (callCount === 2) return stream2;
      retryInput = input;
      return retryStream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 's1',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService },
  });
  const { turnCoordinator, stateFacade } = bundle;

  for await (const _ of turnCoordinator.start('first tool turn')) {
  }

  for await (const _ of turnCoordinator.start('second tool turn')) {
  }

  stateFacade.undoLastUserTurn();

  const stateAfterUndo = stateFacade.exportState();
  expect(
    stateAfterUndo.toolLedger.map((entry) => entry.callId),
    'undo should retain tool ledger entries for still-retained earlier turns',
  ).toEqual([firstToolCallId]);

  for await (const _ of turnCoordinator.start('retry second turn')) {
  }

  expect(Array.isArray(retryInput)).toBe(true);
  const retryCallIds = (retryInput as Record<string, unknown>[])
    .filter((item) => item.callId || item.call_id)
    .map((item) => item.callId || item.call_id);
  expect(retryCallIds.includes(firstToolCallId)).toBe(true);
  expect(retryCallIds.includes(secondToolCallId)).toBe(false);
});
