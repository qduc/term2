import { it, expect, vi } from 'vitest';
import { InitialTurnRecoveryHandler } from './initial-turn-recovery-handler.js';
import { TurnAttempt } from './turn-attempt.js';
import { CodexResponsesTransport, CodexResponsesWSModel } from '../../providers/codex-responses-model.js';
import { AmbiguousModelOutcomeError } from '../retry/retry-errors.js';
import { recordWebSocketDispatch, UnsentWebSocketRequestError } from '../../providers/websocket-request-dispatch.js';
import { DefaultConversationRecoveryPolicy } from '../retry/recovery-policy.js';
import { DefaultRetryClassifier } from '../retry/retry-classifier.js';
import { RetryRecoveryBudgetExhaustedError } from '../retry/retry-recovery-budget.js';

function createAttempt() {
  return new TurnAttempt({
    turn: { text: 'retry me' },
    token: 2,
    initialRetryCounts: {
      transientRetryCount: 0,
      serviceTierFallbackCount: 0,
      modelRetryCount: 0,
      transportDowngradeCount: 0,
    },
    initialJournalSnapshot: [],
    maxTransientRetries: 3,
  });
}

async function watchdogTimeoutError(dispatch: 'unsent' | 'flushed'): Promise<unknown> {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.fetchResponse = async (request: any) => {
    recordWebSocketDispatch(request, dispatch);
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise((_, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
          }),
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  };
  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => undefined } as any,
    undefined,
    undefined,
    undefined,
    { firstFrameMs: 10, interFrameMs: 20 },
    transport,
  );
  const pending = (async () => {
    for await (const _event of model.stream({ input: [], tools: [] } as any)) {
      // The watchdog must fail before the provider yields any raw frame.
    }
  })();
  void pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(10);
  return pending.catch((reason) => reason);
}

async function connectTimeoutError(dispatch: 'unsent' | 'flushed' | 'unknown'): Promise<unknown> {
  const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
  transport.fetchResponse = async (request: any) => {
    if (dispatch !== 'unknown') recordWebSocketDispatch(request, dispatch);
    const error = Object.assign(new Error('WebSocket connect timed out'), { code: 'ETIMEDOUT' });
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(error),
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  };
  const model = new CodexResponsesWSModel(
    { baseURL: 'https://api.openai.com', apiKey: 'test-key', _options: {} } as any,
    'gpt-5-codex',
    { getOrRefreshAccessToken: async () => 'token', getAccountId: () => undefined } as any,
    undefined,
    undefined,
    undefined,
    { firstFrameMs: 10, interFrameMs: 20 },
    transport,
  );
  const pending = (async () => {
    for await (const _event of model.stream({ input: [], tools: [] } as any)) {
      // A connect-time failure must happen before any raw frame.
    }
  })();
  return pending.catch((reason) => reason);
}

async function drain(generator: AsyncGenerator<unknown, unknown, void>): Promise<unknown> {
  // The handler yields presentation events before it reaches the recovery
  // executor, so a single step would never observe the plan.
  let step = await generator.next();
  while (!step.done) step = await generator.next();
  return step.value;
}

function recoveryHandlerRecordingPlans(plans: unknown[], freshStartRetriesAllowed = true) {
  return new InitialTurnRecoveryHandler({
    conversationStore: { getHistory: () => [] } as any,
    freshStartRetriesAllowed,
    generationGuard: { isCurrent: () => true } as any,
    inputPlanner: { recordSuccess: () => {} } as any,
    logger: { warn: () => {}, error: () => {}, getCorrelationId: () => undefined } as any,
    recoveryExecutor: {
      apply: ({ plan }: any) => {
        plans.push(plan);
        return { kind: 'run', instruction: { skipUserMessage: true }, events: [] };
      },
    } as any,
    recoveryPolicy: new DefaultConversationRecoveryPolicy(),
    retryClassifier: new DefaultRetryClassifier({} as any, () => 0),
    retryEventPresenter: { present: () => ({ event: {}, logMessage: '', logFields: {} }) } as any,
    sessionId: 'watchdog-recovery',
  });
}

// ROADMAP.md Phase 2: a first-frame watchdog timeout the send path proved never
// reached the wire is safe to rebuild from durable history, because no model
// work can have started. This is the repair of the retained red proof.
it('recovers a provably unsent watchdog timeout as a fresh full-history retry', async () => {
  vi.useFakeTimers();
  try {
    const error = await watchdogTimeoutError('unsent');
    expect(error).toBeInstanceOf(UnsentWebSocketRequestError);
    expect(error).not.toBeInstanceOf(AmbiguousModelOutcomeError);

    const plans: unknown[] = [];
    await drain(recoveryHandlerRecordingPlans(plans).handle({ error, attempt: createAttempt(), stream: null }) as any);

    expect(plans).toEqual([{ kind: 'retry_fresh', inputMode: 'full_history', disableChainingForAttempt: true }]);
  } finally {
    vi.useRealTimers();
  }
});

// The other half stays closed: once the frame was flushed to an open socket the
// server may already have accepted it, so the turn ends rather than risking a
// duplicated request.
it('still terminates a watchdog timeout whose request may have been accepted', async () => {
  vi.useFakeTimers();
  try {
    const error = await watchdogTimeoutError('flushed');
    expect(error).toBeInstanceOf(AmbiguousModelOutcomeError);

    const plans: unknown[] = [];
    await drain(recoveryHandlerRecordingPlans(plans).handle({ error, attempt: createAttempt(), stream: null }) as any);

    expect(plans).toEqual([{ kind: 'terminate', events: [] }]);
  } finally {
    vi.useRealTimers();
  }
});

it('recovers a connect-time ETIMEDOUT with positive unsent evidence even when fresh starts are disabled', async () => {
  const error = await connectTimeoutError('unsent');
  expect(error).toBeInstanceOf(UnsentWebSocketRequestError);
  expect(error).not.toBeInstanceOf(AmbiguousModelOutcomeError);

  const plans: unknown[] = [];
  await drain(
    recoveryHandlerRecordingPlans(plans, false).handle({ error, attempt: createAttempt(), stream: null }) as any,
  );

  expect(plans).toEqual([{ kind: 'retry_fresh', inputMode: 'full_history', disableChainingForAttempt: true }]);
});

it.each(['flushed', 'unknown'] as const)('keeps a connect-time ETIMEDOUT %s dispatch fail-closed', async (dispatch) => {
  const error = await connectTimeoutError(dispatch);
  expect(error).toBeInstanceOf(AmbiguousModelOutcomeError);
  expect(error).not.toBeInstanceOf(UnsentWebSocketRequestError);

  const plans: unknown[] = [];
  await drain(
    recoveryHandlerRecordingPlans(plans, false).handle({ error, attempt: createAttempt(), stream: null }) as any,
  );

  expect(plans).toEqual([{ kind: 'terminate', events: [] }]);
});

it('returns the scheduled delay for bounded conversation-state recovery', async () => {
  const nextCounts = {
    transientRetryCount: 1,
    serviceTierFallbackCount: 0,
    modelRetryCount: 0,
    transportDowngradeCount: 0,
  };
  const handler = new InitialTurnRecoveryHandler({
    conversationStore: { getHistory: () => [] } as any,
    freshStartRetriesAllowed: true,
    generationGuard: { isCurrent: () => true } as any,
    inputPlanner: { recordSuccess: () => {} } as any,
    logger: {
      warn: () => {},
      error: () => {},
      getCorrelationId: () => undefined,
    } as any,
    recoveryExecutor: {
      apply: () => ({
        kind: 'run',
        instruction: { skipUserMessage: true, retryCounts: nextCounts },
        events: [],
      }),
    } as any,
    recoveryPolicy: {
      nextRetryCounts: () => nextCounts,
      plan: () => ({ kind: 'retry_fresh', inputMode: 'full_history' }),
    } as any,
    retryClassifier: {
      classify: () => ({ kind: 'chain_recovery', attempt: 1, delayMs: 25 }),
    } as any,
    retryEventPresenter: {
      present: () => ({
        event: { type: 'retry', attempt: 1, maxAttempts: 3, delayMs: 25 },
        logMessage: 'Retrying',
        logFields: {},
      }),
    } as any,
    sessionId: 'session-1',
  });
  const attempt = createAttempt();

  const events: unknown[] = [];
  const iterator = handler.handle({ error: new Error('temporary'), attempt, stream: null });
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  expect(events).toEqual([{ type: 'retry', attempt: 1, maxAttempts: 3, delayMs: 25 }]);
  expect(next.value.kind).toBe('run');
  if (next.value.kind === 'run') {
    expect(next.value.delayMs).toBe(25);
  }
  expect(attempt.recoveryBudget.physicalAttempts).toBe(1);
  expect(attempt.retryCounts).toEqual(nextCounts);
});

// Blocking fresh starts exists to stop a subagent replaying a task it already
// began. `chain_recovery` replays nothing — it severs the response chain and
// rebuilds from full history — so a connect-time drop must stay recoverable
// even for a session that forbids fresh starts. `recovery-policy.ts` was
// narrowed to `transient` for this reason; the handler short-circuits before
// the policy is consulted and must agree with it.
it('recovers a chain_recovery failure without a stream even when fresh starts are blocked', async () => {
  const plans: unknown[] = [];
  const handler = new InitialTurnRecoveryHandler({
    breakChaining: () => {},
    conversationStore: { getHistory: () => [] } as any,
    freshStartRetriesAllowed: false,
    generationGuard: { isCurrent: () => true } as any,
    inputPlanner: { recordSuccess: () => {} } as any,
    logger: { warn: () => {}, error: () => {}, getCorrelationId: () => undefined } as any,
    recoveryExecutor: {
      apply: ({ plan }: any) => {
        plans.push(plan);
        return { kind: 'run', instruction: { skipUserMessage: true }, events: [] };
      },
    } as any,
    recoveryPolicy: new DefaultConversationRecoveryPolicy(),
    retryClassifier: { classify: () => ({ kind: 'chain_recovery', attempt: 1, delayMs: 5 }) } as any,
    retryEventPresenter: { present: () => ({ event: {}, logMessage: '', logFields: {} }) } as any,
    sessionId: 'subagent-chain-recovery',
  });

  const result: any = await drain(
    handler.handle({ error: new Error('closed early'), attempt: createAttempt(), stream: null }) as any,
  );

  expect(result.kind).toBe('run');
  expect(plans).toEqual([{ kind: 'retry_fresh', inputMode: 'full_history', disableChainingForAttempt: true }]);
});

// The half that stays closed. Both of these can reach a plan that replays the
// task from the beginning -- `model_retry` maps to `replay_turn` with
// `rollbackUserMessage` -- which is exactly what the block exists to stop.
it.each([{ kind: 'transient', attempt: 1, delayMs: 5 }, { kind: 'model_retry' }])(
  'still terminates a $kind failure without a stream when fresh starts are blocked',
  async (classified) => {
    const plans: unknown[] = [];
    const handler = new InitialTurnRecoveryHandler({
      conversationStore: { getHistory: () => [] } as any,
      freshStartRetriesAllowed: false,
      generationGuard: { isCurrent: () => true } as any,
      inputPlanner: { recordSuccess: () => {} } as any,
      logger: { warn: () => {}, error: () => {}, getCorrelationId: () => undefined } as any,
      recoveryExecutor: {
        apply: ({ plan }: any) => {
          plans.push(plan);
          return { kind: 'terminated', events: [] };
        },
      } as any,
      recoveryPolicy: new DefaultConversationRecoveryPolicy(),
      retryClassifier: { classify: () => classified } as any,
      retryEventPresenter: { present: () => ({ event: {}, logMessage: '', logFields: {} }) } as any,
      sessionId: 'subagent-blocked',
    });

    const result: any = await drain(
      handler.handle({ error: new Error('temporary'), attempt: createAttempt(), stream: null }) as any,
    );

    expect(result.kind).toBe('terminated');
    expect(plans).toEqual([{ kind: 'terminate', events: [] }]);
  },
);

// classifyProviderFailure sees a plain RetryRecoveryBudgetExhaustedError as
// non-retryable "unknown", so the exhausted flag must recognize the typed
// error directly instead of relying on that generic classification -- this
// is the case the physical-attempt budget actually raises.
it('presents retry_exhausted for a budget-exhaustion error even though it classifies as non-retryable', async () => {
  const handler = new InitialTurnRecoveryHandler({
    conversationStore: { getHistory: () => [] } as any,
    freshStartRetriesAllowed: true,
    generationGuard: { isCurrent: () => true } as any,
    inputPlanner: { recordSuccess: () => {} } as any,
    logger: { warn: () => {}, error: () => {}, getCorrelationId: () => undefined } as any,
    recoveryExecutor: {
      apply: () => ({ kind: 'terminated', events: [] }),
    } as any,
    recoveryPolicy: { plan: () => ({ kind: 'terminate', events: [] }) } as any,
    retryClassifier: { classify: () => ({ kind: 'unrecoverable' }) } as any,
    retryEventPresenter: { present: () => ({ event: {}, logMessage: '', logFields: {} }) } as any,
    sessionId: 'budget-exhausted',
    provider: 'openai',
  });

  const events: any[] = [];
  const iterator = handler.handle({
    error: new RetryRecoveryBudgetExhaustedError(new Error('upstream 503')),
    attempt: createAttempt(),
    stream: null,
  });
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  expect(events.map((e: any) => e.type)).toEqual(['retry_exhausted', 'error']);
  expect(events[0]).toMatchObject({ type: 'retry_exhausted', provider: 'openai', canRetry: true });
});

// model_retry (hallucination detection) has its own maxModelRetries cap,
// independent of the shared 90s/3-attempt/1-replay transport recovery
// budget. Gating replay_turn behind the same 1-automatic-replay allowance as
// transport retries silently cut an established, separately-tested retry
// count in half (see the integration-level regression in
// conversation-service.test.ts: "stops retrying after max hallucination
// retries"). This proves the fix directly: two model_retry replays succeed
// against a budget whose one automatic replay is already claimed by an
// unrelated transport recovery.
it('does not charge settled-tool connection chain_recovery against the automatic-replay budget', async () => {
  const plans: unknown[] = [];
  const handler = new InitialTurnRecoveryHandler({
    conversationStore: { getHistory: () => [] } as any,
    freshStartRetriesAllowed: true,
    generationGuard: { isCurrent: () => true } as any,
    inputPlanner: { recordSuccess: () => {} } as any,
    logger: { warn: () => {}, error: () => {}, getCorrelationId: () => undefined } as any,
    recoveryExecutor: {
      apply: ({ plan }: any) => {
        plans.push(plan);
        return { kind: 'run', instruction: { skipUserMessage: true }, events: [] };
      },
    } as any,
    recoveryPolicy: new DefaultConversationRecoveryPolicy(),
    retryClassifier: {
      classify: () => ({ kind: 'chain_recovery', attempt: 1, delayMs: 5, cause: 'connection_interrupted' }),
    } as any,
    retryEventPresenter: { present: () => ({ event: {}, logMessage: '', logFields: {} }) } as any,
    sessionId: 'post-tool-ws-recovery',
    toolTracker: {
      inspectCommittedToolContinuation: () => ({
        completedToolCount: 1,
        allToolsCompleted: true,
        completedPairsPresentInHistory: true,
      }),
    } as any,
  });
  const attempt = createAttempt();
  expect(attempt.recoveryBudget.claimAutomaticReplay()).toBe(true);

  const first: any = await drain(handler.handle({ error: new Error('closed early'), attempt, stream: null }) as any);
  const second: any = await drain(
    handler.handle({ error: new Error('closed early again'), attempt, stream: null }) as any,
  );

  expect(first.kind).toBe('run');
  expect(second.kind).toBe('run');
  expect(plans).toEqual([
    { kind: 'retry_fresh', inputMode: 'full_history', disableChainingForAttempt: true },
    { kind: 'retry_fresh', inputMode: 'full_history', disableChainingForAttempt: true },
  ]);
  expect(attempt.recoveryBudget.physicalAttempts).toBe(2);
  expect(attempt.recoveryBudget.automaticReplays).toBe(1);
});

it('does not charge model_retry replays against the transport automatic-replay budget', async () => {
  const plans: unknown[] = [];
  const handler = new InitialTurnRecoveryHandler({
    conversationStore: { getHistory: () => [] } as any,
    freshStartRetriesAllowed: true,
    generationGuard: { isCurrent: () => true } as any,
    inputPlanner: { recordSuccess: () => {} } as any,
    logger: { warn: () => {}, error: () => {}, getCorrelationId: () => undefined } as any,
    recoveryExecutor: {
      apply: ({ plan }: any) => {
        plans.push(plan);
        return { kind: 'run', instruction: { skipUserMessage: true }, events: [] };
      },
    } as any,
    recoveryPolicy: new DefaultConversationRecoveryPolicy(),
    retryClassifier: { classify: () => ({ kind: 'model_retry', errorContext: 'hallucination' }) } as any,
    retryEventPresenter: { present: () => ({ event: {}, logMessage: '', logFields: {} }) } as any,
    sessionId: 'model-retry-budget',
  });
  const attempt = createAttempt();
  // An earlier, unrelated transport recovery already used the turn's one
  // automatic replay.
  expect(attempt.recoveryBudget.claimAutomaticReplay()).toBe(true);

  const first: any = await drain(handler.handle({ error: new Error('hallucinated'), attempt, stream: null }) as any);
  const second: any = await drain(
    handler.handle({ error: new Error('hallucinated again'), attempt, stream: null }) as any,
  );

  expect(first.kind).toBe('run');
  expect(second.kind).toBe('run');
  expect(plans.every((plan: any) => plan.kind === 'replay_turn')).toBe(true);
});

// Refusing a plan for lack of automatic-replay budget must still settle the
// turn truthfully -- open tool calls, chain state -- exactly like an
// ordinary termination does. The original code returned 'terminated'
// directly without ever calling recoveryExecutor.apply, silently skipping
// that settlement (requirement: no blind redispatch or false failure/success
// on tool execution state).
it('settles the turn through recoveryExecutor when refusing a plan for exhausted replay budget', async () => {
  const applyCalls: unknown[] = [];
  const handler = new InitialTurnRecoveryHandler({
    conversationStore: { getHistory: () => [] } as any,
    freshStartRetriesAllowed: true,
    generationGuard: { isCurrent: () => true } as any,
    inputPlanner: { recordSuccess: () => {} } as any,
    logger: { warn: () => {}, error: () => {}, getCorrelationId: () => undefined } as any,
    recoveryExecutor: {
      apply: (input: any) => {
        applyCalls.push(input);
        if (input.plan.kind === 'terminate') {
          return {
            kind: 'terminated',
            events: [{ type: 'tool_recovery', recoveredCallIds: [], droppedCallIds: ['call-1'], message: 'dropped' }],
          };
        }
        return { kind: 'run', instruction: { skipUserMessage: true }, events: [] };
      },
    } as any,
    recoveryPolicy: new DefaultConversationRecoveryPolicy(),
    retryClassifier: { classify: () => ({ kind: 'transient', attempt: 1, delayMs: 5 }) } as any,
    retryEventPresenter: { present: () => ({ event: {}, logMessage: '', logFields: {} }) } as any,
    sessionId: 'budget-refusal-settlement',
  });
  const attempt = createAttempt();
  expect(attempt.recoveryBudget.claimAutomaticReplay()).toBe(true);

  const events: any[] = [];
  const iterator = handler.handle({ error: new Error('temporary'), attempt, stream: null });
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  expect(applyCalls).toEqual([expect.objectContaining({ plan: { kind: 'terminate', events: [] } })]);
  // First event is the transient-retry presentation (mocked to {}, so its
  // type is undefined); what matters is the settlement and exhaustion events
  // that follow once the budget refuses the plan.
  expect(events.map((e: any) => e.type)).toEqual([undefined, 'tool_recovery', 'retry_exhausted']);
  expect(next.value).toEqual({ kind: 'terminated' });
});

it('returns stale before classifying when the generation is outdated', async () => {
  const handler = new InitialTurnRecoveryHandler({
    conversationStore: {} as any,
    freshStartRetriesAllowed: true,
    generationGuard: { isCurrent: () => false } as any,
    inputPlanner: {} as any,
    logger: {} as any,
    recoveryExecutor: {} as any,
    recoveryPolicy: {} as any,
    retryClassifier: { classify: () => expect(true).toBe(false) } as any,
    retryEventPresenter: {} as any,
    sessionId: 'session-1',
  });

  const iterator = handler.handle({ error: new Error('stale'), attempt: createAttempt(), stream: null });
  const result = await iterator.next();

  expect(result.done).toBe(true);
  expect(result.value).toEqual({ kind: 'stale' });
});
