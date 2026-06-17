import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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
  let capturedContext: any = null;
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

it('plain success', async () => {
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
    expect(outcome.terminal.finalText).toBe('hello response');
  } else {
    expect(true).toBe(false);
  }
  expect(attempt.closed).toBe(true);
});

it('a fresh user turn resets the assistant journal sequence', async () => {
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
  const journal = composition.ensureJournal(() => undefined);
  let resetCalls = 0;
  const originalReset = journal.resetForNewTurn.bind(journal);
  journal.resetForNewTurn = () => {
    resetCalls++;
    return originalReset();
  };

  const token = composition.generationGuard.capture();
  const attempt = new TurnAttempt({
    turn: { text: 'hello' },
    token,
    initialRetryCounts: defaultRetryCounts,
    initialLedgerSnapshot: [],
    maxTransientRetries: 3,
  });

  const it = runner.run(attempt);
  for await (const _ of it) {
    // drain
  }

  expect(resetCalls).toBe(1);
});

it('input-surge block and user-message rollback', async () => {
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
  expect(outcome.kind).toBe('failed');
  expect(events.some((e) => e.type === 'error' && e.kind === 'input_surge_guard')).toBe(true);
  expect(attempt.addedUserMessage).toBe(true);
  expect(composition.conversationStore.getHistory().length, 'User message should be rolled back').toBe(0);
});

it('unrecoverable failure before stream creation', async () => {
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

  await expect(async () => {
    const it = runner.run(attempt);
    for await (const event of it) {
      events.push(event);
    }
  }).rejects.toThrow('Some unrecoverable error');

  expect(events.some((e) => e.type === 'error')).toBe(true);
  expect(recoveryApplyCalls).toBe(1);
});

it('stale finalization returns no terminal and does not mutate approval state', async () => {
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

  expect(result.value).toEqual({ kind: 'stale' });
  expect(composition.approvalState.getPending()).toBe(pending);
});

it('continuation recovery delay checks generation before one-shot client mutation', async () => {
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
  try {
    const iterator = runner.run(attempt, {
      skipUserMessage: true,
      delayMs: 100,
      useStandardServiceTier: true,
    });
    let result = await iterator.next();
    while (!result.done) {
      result = await iterator.next();
    }

    expect(result.value).toEqual({ kind: 'stale' });
    expect(standardTierCalls).toBe(0);
    expect(startCalls).toBe(0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

it('aborted-approval input reusing the current token', async () => {
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
  expect(outcome.kind).toBe('abort_resolution_required');
  if (outcome.kind === 'abort_resolution_required') {
    expect(outcome.abortedContext).toBe(abortedContext);
    expect(outcome.userText).toBe('resolved text');
    expect(outcome.generation).toBe(token);
  }
  expect(events.length).toBe(1);
  expect(events[0].type).toBe('user_message_consumed_for_abort');
});

it('stale aborted-approval context produces no mutation', async () => {
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
  expect(outcome.kind).toBe('stale');
  expect(events.length).toBe(0);
});
