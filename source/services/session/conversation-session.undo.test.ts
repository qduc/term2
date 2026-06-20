import { it, expect } from 'vitest';
import { createConversationSession } from '../../test-helpers/conversation-session-with-adapter.js';
import { MockStream } from '../test-helpers/mock-stream.js';
import {
  mockLogger,
  sessionContextService,
  createMockAgentClient,
} from './test-helpers/conversation-session-fixtures.js';
import type { ClientCall } from './test-helpers/conversation-session-fixtures.js';
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
