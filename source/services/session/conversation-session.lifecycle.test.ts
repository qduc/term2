import { it, expect } from 'vitest';
import type { RunState } from '@openai/agents';
import { createConversationSession } from '../../test-helpers/conversation-session-with-adapter.js';
import { MockStream } from '../test-helpers/mock-stream.js';
import {
  mockLogger,
  sessionContextService,
  createMockSettingsService,
  createMockAgentClient,
} from './test-helpers/conversation-session-fixtures.js';
import type { ClientCall } from './test-helpers/conversation-session-fixtures.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
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

it('run() keeps follow-up input as a user turn when resolving an aborted approval', async () => {
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
  expect(idx >= 0).toBe(false);
  expect(stateFacade.listUserTurns().map((turn) => turn.text)).toEqual(['follow up text']);
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
