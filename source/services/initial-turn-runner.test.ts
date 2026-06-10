import test from 'ava';
import { createConversationSessionComposition } from './conversation-session-composition.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { MockStream } from './test-helpers/mock-stream.js';
import { InitialTurnRunner, type InitialTurnRunnerDeps } from './initial-turn-runner.js';
import { TurnAttempt } from './turn-attempt.js';
import type { RetryCounts } from './retry-contracts.js';
import { ChainingTransportDowngradeError } from '../providers/fallback-responses-model.js';
import type { AbortedApprovalContext } from './approval-state.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
};

const createSessionContextService = () => {
  let capturedContext = null;
  return {
    runWithContext: (context: any, fn: any) => {
      capturedContext = context;
      return fn();
    },
    getContext: () => capturedContext,
  };
};

function setupRunner(mockClient: any, retryOptions?: any) {
  const composition = createConversationSessionComposition({
    sessionId: 'test-session',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
    turnAccumulator: new TurnItemAccumulator(),
    retryOptions,
  });

  const runner = new InitialTurnRunner({
    ...composition,
    agentClient: mockClient,
    logger: mockLogger,
    sessionId: 'test-session',
  } as unknown as InitialTurnRunnerDeps);
  return { runner, composition };
}

const defaultRetryCounts: RetryCounts = {
  transientRetryCount: 0,
  serviceTierFallbackCount: 0,
  modelRetryCount: 0,
  transportDowngradeCount: 0,
};

test('plain success', async (t) => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'hello response' }]);
  stream.finalOutput = 'hello response';

  const mockClient = {
    getProvider() {
      return 'openai';
    },
    async startStream() {
      return stream;
    },
  };

  const { runner, composition } = setupRunner(mockClient);
  const token = composition.generationGuard.capture();
  const attempt = new TurnAttempt({
    turn: { text: 'hello' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialLedgerSnapshot: [],
    maxTransientRetries: 3,
  });

  const events: any[] = [];
  const runPromise = (async () => {
    const it = runner.run(attempt);
    let res = await it.next();
    while (!res.done) {
      events.push(res.value);
      res = await it.next();
    }
    return res.value;
  })();

  const outcome = await runPromise;
  if (outcome.kind === 'response' && outcome.terminal.type === 'response') {
    t.is(outcome.terminal.finalText, 'hello response');
  } else {
    t.fail('Expected response outcome with FinalTerminal');
  }
  t.is(attempt.closed, true);
});

test('input-surge block and user-message rollback', async (t) => {
  const mockClient = {
    getProvider() {
      return 'openai';
    },
    async startStream() {
      return new MockStream([]);
    },
  };

  const { runner, composition } = setupRunner(mockClient);

  // Configure input planner to trigger surge block
  composition.inputPlanner.inspectForSurge = () => ({
    action: 'block',
    reason: 'Context limit exceeded',
    stats: {
      messageCount: 0,
      totalSerializedBytes: 0,
      duplicateToolCallSignatures: 0,
      maxDuplicateToolCallSignatureCount: 0,
    },
    previousStats: {
      messageCount: 0,
      totalSerializedBytes: 0,
      duplicateToolCallSignatures: 0,
      maxDuplicateToolCallSignatureCount: 0,
    },
  });

  const token = composition.generationGuard.capture();
  const attempt = new TurnAttempt({
    turn: { text: 'hello' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialLedgerSnapshot: [],
    maxTransientRetries: 3,
  });

  const events: any[] = [];
  const runPromise = (async () => {
    const it = runner.run(attempt);
    let res = await it.next();
    while (!res.done) {
      events.push(res.value);
      res = await it.next();
    }
    return res.value;
  })();

  const outcome = await runPromise;
  t.is(outcome.kind, 'failed');
  t.true(events.some((e) => e.type === 'error' && e.kind === 'input_surge_guard'));
  t.is(attempt.addedUserMessage, true);
  t.is(composition.conversationStore.getHistory().length, 0, 'User message should be rolled back');
});

test('chaining downgrade to full history', async (t) => {
  const successfulStream = new MockStream([{ type: 'response.output_text.delta', delta: 'fallback response' }]);
  successfulStream.finalOutput = 'fallback response';

  let startStreamCalls = 0;
  const mockClient = {
    getProvider() {
      return 'openai';
    },
    async startStream() {
      startStreamCalls++;
      if (startStreamCalls === 1) {
        throw new ChainingTransportDowngradeError('chaining broken');
      }
      return successfulStream;
    },
  };

  const { runner, composition } = setupRunner(mockClient);
  const token = composition.generationGuard.capture();
  const attempt = new TurnAttempt({
    turn: { text: 'hello' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialLedgerSnapshot: [],
    maxTransientRetries: 3,
  });

  const events: any[] = [];
  const runPromise = (async () => {
    const it = runner.run(attempt);
    let res = await it.next();
    while (!res.done) {
      events.push(res.value);
      res = await it.next();
    }
    return res.value;
  })();

  const outcome = await runPromise;
  if (outcome.kind === 'response' && outcome.terminal.type === 'response') {
    t.is(outcome.terminal.finalText, 'fallback response');
  } else {
    t.fail('Expected response outcome with FinalTerminal');
  }
  t.is(startStreamCalls, 2);
  t.is(attempt.inputMode, 'full_history');
});

test('transient retry before stream creation', async (t) => {
  let startCalls = 0;
  const successfulStream = new MockStream([{ type: 'response.output_text.delta', delta: 'recovered response' }]);
  successfulStream.finalOutput = 'recovered response';

  const mockClient = {
    getProvider() {
      return 'openai';
    },
    getStreamMaxRetries() {
      return 3;
    },
    async startStream() {
      startCalls++;
      if (startCalls === 1) {
        throw new Error('WebSocket connection closed before response completed (code=1006)');
      }
      return successfulStream;
    },
  };

  const { runner, composition } = setupRunner(mockClient);
  const token = composition.generationGuard.capture();
  const attempt = new TurnAttempt({
    turn: { text: 'hello' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialLedgerSnapshot: [],
    maxTransientRetries: 3,
  });

  // Shorten retry classifier delay for test speed
  composition.retryClassifier.classify = (ctx: any) => {
    const res = composition.retryClassifier.constructor.prototype.classify.call(composition.retryClassifier, ctx);
    if (res.kind === 'transient') {
      res.delayMs = 1;
    }
    return res;
  };

  const events: any[] = [];
  const runPromise = (async () => {
    const it = runner.run(attempt);
    let res = await it.next();
    while (!res.done) {
      events.push(res.value);
      res = await it.next();
    }
    return res.value;
  })();

  const outcome = await runPromise;
  if (outcome.kind === 'response' && outcome.terminal.type === 'response') {
    t.is(outcome.terminal.finalText, 'recovered response');
  } else {
    t.fail('Expected response outcome with FinalTerminal');
  }
  t.is(startCalls, 2);
  t.is(attempt.retryCounts.transientRetryCount, 1);
});

test('transient retry during stream iteration', async (t) => {
  class FailingStream extends MockStream {
    async *[Symbol.asyncIterator]() {
      yield { type: 'response.output_text.delta', delta: 'partial text' };
      throw new Error('WebSocket connection closed before response completed (code=1006)');
    }
  }

  const failingStream = new FailingStream([]);
  const successfulStream = new MockStream([{ type: 'response.output_text.delta', delta: 'retry ok' }]);
  successfulStream.finalOutput = 'retry ok';

  let startCalls = 0;
  const mockClient = {
    getProvider() {
      return 'openai';
    },
    getStreamMaxRetries() {
      return 3;
    },
    async startStream() {
      startCalls++;
      if (startCalls === 1) {
        return failingStream;
      }
      return successfulStream;
    },
  };

  const { runner, composition } = setupRunner(mockClient);
  const token = composition.generationGuard.capture();
  const attempt = new TurnAttempt({
    turn: { text: 'hello' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialLedgerSnapshot: [],
    maxTransientRetries: 3,
  });

  // Shorten retry classifier delay for test speed
  composition.retryClassifier.classify = (ctx: any) => {
    const res = composition.retryClassifier.constructor.prototype.classify.call(composition.retryClassifier, ctx);
    if (res.kind === 'transient') {
      res.delayMs = 1;
    }
    return res;
  };

  const events: any[] = [];
  const runPromise = (async () => {
    const it = runner.run(attempt);
    let res = await it.next();
    while (!res.done) {
      events.push(res.value);
      res = await it.next();
    }
    return res.value;
  })();

  const outcome = await runPromise;
  if (outcome.kind === 'response' && outcome.terminal.type === 'response') {
    t.is(outcome.terminal.finalText, 'retry ok');
  } else {
    t.fail('Expected response outcome with FinalTerminal');
  }
  t.is(attempt.retryCounts.transientRetryCount, 1);
});

test('unrecoverable failure before stream creation', async (t) => {
  const mockClient = {
    getProvider() {
      return 'openai';
    },
    async startStream() {
      throw new Error('Some unrecoverable error');
    },
  };

  const { runner, composition } = setupRunner(mockClient);
  const token = composition.generationGuard.capture();
  const attempt = new TurnAttempt({
    turn: { text: 'hello' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialLedgerSnapshot: [],
    maxTransientRetries: 3,
  });

  const events: any[] = [];
  await t.throwsAsync(
    async () => {
      const it = runner.run(attempt);
      for await (const event of it) {
        events.push(event);
      }
    },
    { message: 'Some unrecoverable error' },
  );

  t.true(events.some((e) => e.type === 'error'));
});

test('stale generation during retry delay', async (t) => {
  let startCalls = 0;
  const mockClient = {
    getProvider() {
      return 'openai';
    },
    getStreamMaxRetries() {
      return 3;
    },
    async startStream() {
      startCalls++;
      throw new Error('WebSocket connection closed before response completed (code=1006)');
    },
  };

  const { runner, composition } = setupRunner(mockClient);
  const token = composition.generationGuard.capture();
  const attempt = new TurnAttempt({
    turn: { text: 'hello' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialLedgerSnapshot: [],
    maxTransientRetries: 3,
  });

  // Intercept the transient retry classification to invalidate generation
  composition.retryClassifier.classify = (ctx: any) => {
    const res = composition.retryClassifier.constructor.prototype.classify.call(composition.retryClassifier, ctx);
    if (res.kind === 'transient') {
      res.delayMs = 10;
      // Invalidate generation directly
      composition.generationGuard.invalidate();
    }
    return res;
  };

  const events: any[] = [];
  const runPromise = (async () => {
    const it = runner.run(attempt);
    let res = await it.next();
    while (!res.done) {
      events.push(res.value);
      res = await it.next();
    }
    return res.value;
  })();

  const outcome = await runPromise;
  t.is(outcome.kind, 'stale');
  t.is(startCalls, 1);
});

test('aborted-approval input reusing the current token', async (t) => {
  const interruption = {
    name: 'shell',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo hello' }),
    callId: 'call-1',
  };

  const continuationStream = new MockStream([{ type: 'response.output_text.delta', delta: 'resolved' }]);
  continuationStream.finalOutput = 'resolved';

  const mockClient = {
    getProvider() {
      return 'openai';
    },
    async continueRunStream() {
      return continuationStream;
    },
  };

  const { runner, composition } = setupRunner(mockClient);
  const token = composition.generationGuard.capture();

  const abortedContext = {
    token,
    interruption,
    addedUserMessage: true,
    state: {
      approve: () => {},
      reject: () => {},
    },
    emittedCommandIds: new Set<string>(),
    toolCallArgumentsById: {},
  } as unknown as AbortedApprovalContext;

  const attempt = new TurnAttempt({
    turn: { text: 'resolved text' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialLedgerSnapshot: [],
    maxTransientRetries: 3,
  });

  const events: any[] = [];
  const runPromise = (async () => {
    const it = runner.run(attempt, { abortedContext });
    let res = await it.next();
    while (!res.done) {
      events.push(res.value);
      res = await it.next();
    }
    return res.value;
  })();

  const outcome = await runPromise;
  if (outcome.kind === 'response' && outcome.terminal.type === 'response') {
    t.is(outcome.terminal.finalText, 'resolved');
  } else {
    t.fail('Expected response outcome with FinalTerminal');
  }
});

test('stale aborted-approval context produces no mutation', async (t) => {
  const interruption = {
    name: 'shell',
    agent: { name: 'CLI Agent' },
    arguments: JSON.stringify({ command: 'echo hello' }),
    callId: 'call-1',
  };

  const mockClient = {
    getProvider() {
      return 'openai';
    },
  };

  const { runner, composition } = setupRunner(mockClient);
  const token = composition.generationGuard.capture();

  // Invalidate generation to make abortedContext stale
  composition.generationGuard.invalidate();

  const abortedContext = {
    token,
    interruption,
    addedUserMessage: true,
    state: {
      approve: () => {},
      reject: () => {},
    },
    emittedCommandIds: new Set<string>(),
    toolCallArgumentsById: {},
  } as unknown as AbortedApprovalContext;

  const attempt = new TurnAttempt({
    turn: { text: 'resolved text' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialLedgerSnapshot: [],
    maxTransientRetries: 3,
  });

  const events: any[] = [];
  const runPromise = (async () => {
    const it = runner.run(attempt, { abortedContext });
    let res = await it.next();
    while (!res.done) {
      events.push(res.value);
      res = await it.next();
    }
    return res.value;
  })();

  const outcome = await runPromise;
  t.is(outcome.kind, 'stale');
  t.is(events.length, 0);
});
