import test from 'ava';
import { createConversationSessionComposition } from './session-composition.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { MockStream } from '../test-helpers/mock-stream.js';
import { TurnAttempt } from './turn-attempt.js';
import type { RetryCounts } from '../retry/retry-contracts.js';
import type { AbortedApprovalContext } from '../approval/approval-state.js';

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

  return { runner: composition.initialTurnRunner, composition };
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
  let recoveryApplyCalls = 0;
  const originalApply = composition.recoveryExecutor.apply.bind(composition.recoveryExecutor);
  composition.recoveryExecutor.apply = (input: any) => {
    recoveryApplyCalls++;
    return originalApply(input);
  };
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
  t.is(recoveryApplyCalls, 1);
});

test('stale finalization returns no terminal and does not mutate approval state', async (t) => {
  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'stale response' }]);
  stream.finalOutput = 'stale response';

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
  const pending = {
    state: {} as any,
    interruption: { name: 'shell', arguments: '{}', callId: 'pending-call' },
    emittedCommandIds: new Set<string>(),
    toolCallArgumentsById: new Map<string, unknown>(),
    owner: { kind: 'parent' as const },
    token,
  };
  composition.approvalState.setPending(pending);
  composition.streamProcessor.finalize = () => ({ kind: 'stale' });

  const attempt = new TurnAttempt({
    turn: { text: 'hello' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialLedgerSnapshot: [],
    maxTransientRetries: 3,
  });

  const iterator = runner.run(attempt);
  let result = await iterator.next();
  while (!result.done) {
    result = await iterator.next();
  }

  t.deepEqual(result.value, { kind: 'stale' });
  t.is(composition.approvalState.getPending(), pending);
});

test('continuation recovery delay checks generation before one-shot client mutation', async (t) => {
  let startCalls = 0;
  let standardTierCalls = 0;
  const mockClient = {
    getProvider() {
      return 'openai';
    },
    useStandardServiceTierForNextRequest() {
      standardTierCalls++;
    },
    async startStream() {
      startCalls++;
      return new MockStream([]);
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

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: (...args: any[]) => void) => {
    composition.generationGuard.invalidate();
    return originalSetTimeout(handler, 0);
  }) as typeof setTimeout;
  t.teardown(() => {
    globalThis.setTimeout = originalSetTimeout;
  });

  const iterator = runner.run(attempt, {
    skipUserMessage: true,
    delayMs: 100,
    useStandardServiceTier: true,
  });
  let result = await iterator.next();
  while (!result.done) {
    result = await iterator.next();
  }

  t.deepEqual(result.value, { kind: 'stale' });
  t.is(standardTierCalls, 0);
  t.is(startCalls, 0);
});

test('aborted-approval input reusing the current token', async (t) => {
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
  t.is(outcome.kind, 'abort_resolution_required');
  if (outcome.kind === 'abort_resolution_required') {
    t.is(outcome.abortedContext, abortedContext);
    t.is(outcome.userText, 'resolved text');
    t.is(outcome.generation, token);
  }
  t.is(events.length, 1);
  t.is(events[0].type, 'user_message_consumed_for_abort');
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
