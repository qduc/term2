import { it, expect, vi } from 'vitest';
import { ContinuationRecoveryHandler } from './continuation-recovery-handler.js';
import { RetryRecoveryBudget } from '../retry/retry-recovery-budget.js';
import { DefaultRetryClassifier } from '../retry/retry-classifier.js';
import { DefaultConversationRecoveryPolicy } from '../retry/recovery-policy.js';

function createMockState(overrides: any = {}) {
  return {
    token: 1,
    retryCounts: {
      transientRetryCount: 0,
      serviceTierFallbackCount: 0,
      modelRetryCount: 0,
      transportDowngradeCount: 0,
    },
    lastStream: null,
    journalSnapshot: [],
    currentState: { id: 'run-1' },
    currentCallIds: ['call-1'],
    recoveryBudget: new RetryRecoveryBudget(),
    setRetryCounts: (_counts: any) => {
      // mutate in place
    },
    setResumePreviousResponseId: (_id: any) => {},
    ...overrides,
  };
}

function invalidPreviousResponseError(): Error {
  return Object.assign(
    new Error(
      'Error: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"Invalid `previous_response_id`."}}',
    ),
    { status: 400 },
  );
}

it('returns terminated for unrecoverable error', async () => {
  const apply = vi.fn(() => ({ kind: 'terminated', events: [] }));
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => true } as any,
    retryClassifier: {
      classify: () => ({ kind: 'unrecoverable' }),
    } as any,
    recoveryPolicy: {} as any,
    recoveryExecutor: {
      apply,
    } as any,
    retryEventPresenter: {} as any,
    resolveRetryLimit: () => 2,
    toolTracker: { activeCallIdsForCurrentTurn: () => [] } as any,
  });

  const events: any[] = [];
  const state = createMockState();
  const iterator = handler.handle({ error: new Error('boom'), state });
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  expect(events.length).toBe(0);
  expect((next.value as any).kind).toBe('terminated');
  expect(apply).toHaveBeenCalledWith(
    expect.objectContaining({ plan: { kind: 'terminate', events: [] }, retryCounts: state.retryCounts }),
  );
});

it('returns stale when generation guard is not current after presentation', async () => {
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => false } as any,
    retryClassifier: {
      classify: () => ({ kind: 'transient', delayMs: 100 }),
    } as any,
    recoveryPolicy: {} as any,
    recoveryExecutor: {} as any,
    retryEventPresenter: {
      present: () => ({ event: { type: 'retry_scheduled' }, logMessage: 'retry', logFields: {} }),
    } as any,
    resolveRetryLimit: () => 2,
    toolTracker: { activeCallIdsForCurrentTurn: () => [] } as any,
  });

  const events: any[] = [];
  const state = createMockState();
  const iterator = handler.handle({ error: new Error('rate limit'), state });
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  expect(events.length).toBe(1);
  expect((next.value as any).kind).toBe('stale');
});

it('returns the scheduled delay for bounded conversation-state fresh recovery', async () => {
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => true } as any,
    retryClassifier: {
      classify: () => ({ kind: 'chain_recovery', attempt: 1, delayMs: 500 }),
    } as any,
    recoveryPolicy: {
      nextRetryCounts: (counts: any) => ({ ...counts, transientRetryCount: counts.transientRetryCount + 1 }),
      plan: () => ({ kind: 'transient' } as any),
    } as any,
    recoveryExecutor: {
      apply: () => ({ kind: 'fresh_start', instruction: {} as any }),
    } as any,
    retryEventPresenter: {
      present: () => ({ event: { type: 'retry_scheduled' }, logMessage: 'retry', logFields: {} }),
    } as any,
    resolveRetryLimit: () => 2,
    toolTracker: { activeCallIdsForCurrentTurn: () => [] } as any,
  });

  const events: any[] = [];
  const state = createMockState();
  const iterator = handler.handle({ error: new Error('rate limit'), state });
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  expect(events.length).toBe(1);
  const value = next.value as any;
  expect(value.kind).toBe('fresh_start');
  expect(value.delayMs).toBe(500);
});

it('returns fresh_start for a stale chained response transport downgrade', async () => {
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => true } as any,
    retryClassifier: {
      classify: () => ({ kind: 'transport_downgrade' }),
    } as any,
    recoveryPolicy: {
      nextRetryCounts: (counts: any) => ({
        ...counts,
        transientRetryCount: 0,
        transportDowngradeCount: counts.transportDowngradeCount + 1,
      }),
      plan: () => ({ kind: 'retry_fresh', inputMode: 'full_history' }),
    } as any,
    recoveryExecutor: {
      apply: () => ({ kind: 'run', instruction: { skipUserMessage: true } }),
    } as any,
    retryEventPresenter: {
      present: () => ({ event: { type: 'retry_scheduled' }, logMessage: 'retry', logFields: {} }),
    } as any,
    resolveRetryLimit: () => 2,
    toolTracker: { activeCallIdsForCurrentTurn: () => [] } as any,
  });

  const events: any[] = [];
  const state = createMockState();
  state.setRetryCounts = (counts: any) => {
    state.retryCounts = counts;
  };
  const iterator = handler.handle({
    error: Object.assign(new Error('previous response not found'), { code: 'previous_response_not_found' }),
    state,
  });
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  expect(events).toHaveLength(1);
  expect(next.value).toMatchObject({
    kind: 'fresh_start',
    retryCounts: {
      transientRetryCount: 0,
      transportDowngradeCount: 1,
    },
  });
});

it('returns resume without widening currentCallIds back to the whole turn ledger', async () => {
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => true } as any,
    retryClassifier: {
      classify: () => ({ kind: 'transient', delayMs: 0 }),
    } as any,
    recoveryPolicy: {
      nextRetryCounts: (counts: any) => ({ ...counts, transientRetryCount: counts.transientRetryCount + 1 }),
      plan: () => ({ kind: 'transient' } as any),
    } as any,
    recoveryExecutor: {
      apply: () => ({
        kind: 'recovered',
        instruction: { resumeState: { id: 'run-2' }, resumePreviousResponseId: 'prev-1' },
      }),
    } as any,
    retryEventPresenter: {
      present: () => ({ event: { type: 'retry_scheduled' }, logMessage: 'retry', logFields: {} }),
    } as any,
    resolveRetryLimit: () => 2,
    toolTracker: { activeCallIdsForCurrentTurn: () => ['call-old', 'call-1'] } as any,
  });

  const events: any[] = [];
  const state = createMockState({ currentCallIds: ['call-1'] });
  const iterator = handler.handle({ error: new Error('rate limit'), state });
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  expect(events.length).toBe(1);
  const value = next.value as any;
  expect(value.kind).toBe('resume');
  expect(state.currentState.id).toBe('run-2');
  expect(state.currentCallIds).toEqual(['call-1']);
});

// Continuation attempts (the tool-call loop) previously had no access to the
// shared recovery budget at all, so a fresh_start replay here was unbounded.
// This proves the budget is now consulted and a second replay in the same
// logical turn is refused rather than silently allowed.
it('refuses a second automatic fresh_start replay once the shared budget is used up', async () => {
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => true } as any,
    retryClassifier: {
      classify: () => ({ kind: 'transport_downgrade' }),
    } as any,
    recoveryPolicy: {
      nextRetryCounts: (counts: any) => counts,
      plan: () => ({ kind: 'retry_fresh', inputMode: 'full_history' }),
    } as any,
    recoveryExecutor: {
      apply: () => ({ kind: 'run', instruction: { skipUserMessage: true } }),
    } as any,
    retryEventPresenter: {
      present: () => ({ event: { type: 'retry_scheduled' }, logMessage: 'retry', logFields: {} }),
    } as any,
    resolveRetryLimit: () => 5,
    toolTracker: { activeCallIdsForCurrentTurn: () => [] } as any,
    provider: 'openai',
  });

  const recoveryBudget = new RetryRecoveryBudget();
  // A prior replay elsewhere in this same logical turn already used up the
  // one automatic replay the shared envelope allows.
  expect(recoveryBudget.claimAutomaticReplay()).toBe(true);

  const events: any[] = [];
  const state = createMockState({ recoveryBudget });
  const iterator = handler.handle({ error: new Error('previous response not found'), state });
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  expect(events.map((e: any) => e.type)).toEqual(['retry_scheduled', 'retry_exhausted']);
  expect((next.value as any).kind).toBe('terminated');
});

it('does not refuse a second settled-tool connection chain_recovery once automatic replay is spent', async () => {
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => true } as any,
    retryClassifier: {
      classify: () => ({ kind: 'chain_recovery', attempt: 1, delayMs: 0, cause: 'connection_interrupted' }),
    } as any,
    recoveryPolicy: {
      nextRetryCounts: (counts: any) => counts,
      plan: () => ({ kind: 'retry_fresh', inputMode: 'full_history', disableChainingForAttempt: true }),
    } as any,
    recoveryExecutor: {
      apply: () => ({ kind: 'run', instruction: { skipUserMessage: true, disableChainingForAttempt: true } }),
    } as any,
    retryEventPresenter: {
      present: () => ({ event: { type: 'retry_scheduled' }, logMessage: 'retry', logFields: {} }),
    } as any,
    resolveRetryLimit: () => 5,
    toolTracker: {
      inspectCommittedToolContinuation: () => ({
        completedToolCount: 1,
        allToolsCompleted: true,
        completedPairsPresentInHistory: true,
      }),
    } as any,
    provider: 'openai',
  });

  const recoveryBudget = new RetryRecoveryBudget();
  expect(recoveryBudget.claimAutomaticReplay()).toBe(true);

  const state = createMockState({ recoveryBudget });
  const iterator = handler.handle({ error: new Error('closed early'), state });
  let next = await iterator.next();
  while (!next.done) next = await iterator.next();

  expect((next.value as any).kind).toBe('fresh_start');
  expect(recoveryBudget.physicalAttempts).toBe(1);
  expect(recoveryBudget.automaticReplays).toBe(1);
});

it('recovers a settled-tool provider state rejection without spending automatic replay', async () => {
  const plans: unknown[] = [];
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => true } as any,
    retryClassifier: new DefaultRetryClassifier({} as any, () => 0),
    recoveryPolicy: new DefaultConversationRecoveryPolicy(),
    recoveryExecutor: {
      apply: ({ plan }: any) => {
        plans.push(plan);
        return { kind: 'run', instruction: { skipUserMessage: true }, events: [] };
      },
    } as any,
    retryEventPresenter: {
      present: () => ({ event: { type: 'retry_scheduled' }, logMessage: 'retry', logFields: {} }),
    } as any,
    resolveRetryLimit: () => 5,
    toolTracker: {
      inspectCommittedToolContinuation: () => ({
        completedToolCount: 1,
        allToolsCompleted: true,
        completedPairsPresentInHistory: true,
      }),
    } as any,
    provider: 'codex',
  });

  const recoveryBudget = new RetryRecoveryBudget();
  expect(recoveryBudget.claimAutomaticReplay()).toBe(true);
  const state = createMockState({
    recoveryBudget,
    lastStream: {
      completed: Promise.resolve(undefined),
      output: [{ type: 'tool_call_dispatched', callId: 'call-1', toolName: 'read_file' }],
      newItems: [],
    },
  });

  const iterator = handler.handle({ error: invalidPreviousResponseError(), state });
  let next = await iterator.next();
  while (!next.done) next = await iterator.next();

  expect((next.value as any).kind).toBe('fresh_start');
  expect(plans).toEqual([{ kind: 'retry_fresh', inputMode: 'full_history', disableChainingForAttempt: true }]);
  expect(recoveryBudget.automaticReplays).toBe(1);
});

// The budget instance passed in must be the one actually consulted -- a
// continuation that constructs its own budget instead of using the shared
// one would let each continuation retry independently, defeating the "one
// shared 90s/3-attempt/1-replay envelope per logical turn" contract.
it('shares one recovery budget instance across the turn rather than tracking its own', async () => {
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => true } as any,
    retryClassifier: {
      classify: () => ({ kind: 'transient', attempt: 1, delayMs: 5 }),
    } as any,
    recoveryPolicy: {
      nextRetryCounts: (counts: any) => counts,
      plan: () => ({ kind: 'transient' } as any),
    } as any,
    recoveryExecutor: {
      apply: () => ({
        kind: 'recovered',
        instruction: { resumeState: { id: 'run-3' }, resumePreviousResponseId: 'prev-2' },
      }),
    } as any,
    retryEventPresenter: {
      present: () => ({ event: { type: 'retry_scheduled' }, logMessage: 'retry', logFields: {} }),
    } as any,
    resolveRetryLimit: () => 5,
    toolTracker: { activeCallIdsForCurrentTurn: () => [] } as any,
  });

  const recoveryBudget = new RetryRecoveryBudget();
  expect(recoveryBudget.startedAt).toBeUndefined();

  const state = createMockState({ recoveryBudget });
  const iterator = handler.handle({ error: new Error('rate limit'), state });
  let next = await iterator.next();
  while (!next.done) next = await iterator.next();

  // The retryable failure was noted on the caller-supplied budget, not a
  // freshly constructed one.
  expect(recoveryBudget.startedAt).toBeDefined();
});

// Mirrors the equivalent initial-turn-recovery-handler.test.ts case: model_retry
// has its own maxModelRetries cap and must not draw against the shared
// transport automatic-replay budget.
it('does not charge a model_retry replay_turn plan against the automatic-replay budget', async () => {
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => true } as any,
    retryClassifier: {
      classify: () => ({ kind: 'model_retry', errorContext: 'hallucination' }),
    } as any,
    recoveryPolicy: {
      nextRetryCounts: (counts: any) => counts,
      plan: () => ({ kind: 'replay_turn', inputMode: 'full_history', rollbackUserMessage: true }),
    } as any,
    recoveryExecutor: {
      apply: () => ({ kind: 'run', instruction: { skipUserMessage: true } }),
    } as any,
    retryEventPresenter: {
      present: () => ({ event: { type: 'retry_scheduled' }, logMessage: 'retry', logFields: {} }),
    } as any,
    resolveRetryLimit: () => 5,
    toolTracker: { activeCallIdsForCurrentTurn: () => [] } as any,
  });

  const recoveryBudget = new RetryRecoveryBudget();
  // An earlier, unrelated transport recovery already used the one automatic
  // replay.
  expect(recoveryBudget.claimAutomaticReplay()).toBe(true);

  const state = createMockState({ recoveryBudget });
  const iterator = handler.handle({ error: new Error('hallucinated'), state });
  let next = await iterator.next();
  while (!next.done) next = await iterator.next();

  // Not 'terminated': the replay_turn plan was executed rather than refused
  // for lack of automatic-replay budget.
  expect((next.value as any).kind).toBe('fresh_start');
});

// Mirrors the equivalent initial-turn-recovery-handler.test.ts case: refusing
// a retry_fresh plan for lack of automatic-replay budget must still settle
// the turn (open tool calls, chain state) through recoveryExecutor, not
// return 'terminated' directly and skip it.
it('settles the turn through recoveryExecutor when refusing a retry_fresh plan for exhausted replay budget', async () => {
  const applyCalls: unknown[] = [];
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => true } as any,
    retryClassifier: {
      classify: () => ({ kind: 'transient', attempt: 1, delayMs: 5 }),
    } as any,
    recoveryPolicy: {
      nextRetryCounts: (counts: any) => counts,
      plan: () => ({ kind: 'retry_fresh', inputMode: 'full_history' }),
    } as any,
    recoveryExecutor: {
      apply: (input: any) => {
        applyCalls.push(input);
        if (input.plan.kind === 'terminate') {
          return {
            kind: 'terminated',
            events: [{ type: 'tool_recovery', recoveredCallIds: [], droppedCallIds: ['call-1'], message: 'dropped' }],
          };
        }
        return { kind: 'run', instruction: { skipUserMessage: true } };
      },
    } as any,
    retryEventPresenter: {
      present: () => ({ event: { type: 'retry_scheduled' }, logMessage: 'retry', logFields: {} }),
    } as any,
    resolveRetryLimit: () => 5,
    toolTracker: { activeCallIdsForCurrentTurn: () => [] } as any,
  });

  const recoveryBudget = new RetryRecoveryBudget();
  expect(recoveryBudget.claimAutomaticReplay()).toBe(true);

  const events: any[] = [];
  const state = createMockState({ recoveryBudget });
  const iterator = handler.handle({ error: new Error('rate limit'), state });
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }

  expect(applyCalls).toEqual([expect.objectContaining({ plan: { kind: 'terminate', events: [] } })]);
  expect(events.map((e: any) => e.type)).toEqual(['retry_scheduled', 'tool_recovery', 'retry_exhausted']);
  expect((next.value as any).kind).toBe('terminated');
});

// Integration-level proof against the real DefaultRetryClassifier (the other
// tests in this file mock retryClassifier, so none of them exercise the
// actual "never replay after committed output" guard this continuation path
// relies on). state.lastStream carries only bookkeeping evidence pushed
// unconditionally by outputPush() in application-run-loop.ts -- see
// agent-stream.test.ts's streamHasCommittedOutput cases -- so the real
// classifier must still see this transient failure as recoverable rather
// than forcing 'unrecoverable' off a bare stream.output.length check.
it('recovers a mid-continuation transient failure through the real classifier when the stream carries only bookkeeping evidence', async () => {
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => true } as any,
    retryClassifier: new DefaultRetryClassifier({} as any, () => 0),
    recoveryPolicy: new DefaultConversationRecoveryPolicy(),
    recoveryExecutor: {
      apply: () => ({
        kind: 'recovered',
        instruction: { resumeState: { id: 'run-2' }, resumePreviousResponseId: 'prev-1' },
      }),
    } as any,
    retryEventPresenter: {
      present: () => ({ event: { type: 'retry_scheduled' }, logMessage: 'retry', logFields: {} }),
    } as any,
    resolveRetryLimit: () => 5,
    toolTracker: { activeCallIdsForCurrentTurn: () => [] } as any,
  });

  const state = createMockState({
    lastStream: {
      completed: Promise.resolve(undefined),
      output: [
        { type: 'run_budget', evidence: { type: 'budget_stage', stage: 'warning' } },
        { type: 'context_compaction_started', provider: 'openai' },
      ],
      newItems: [],
    } as any,
  });
  const iterator = handler.handle({
    error: new Error('Codex WebSocket closed before a terminal response event.'),
    state,
  });
  let next = await iterator.next();
  while (!next.done) next = await iterator.next();

  expect((next.value as any).kind).toBe('resume');
});

// The other half: with the same real classifier, once state.lastStream
// carries real streamed text, the failure must classify as unrecoverable and
// the continuation must terminate rather than replay.
it('terminates a mid-continuation failure through the real classifier once real text output is present', async () => {
  const handler = new ContinuationRecoveryHandler({
    logger: { warn: () => {}, getCorrelationId: () => undefined, error: () => {}, debug: () => {} } as any,
    sessionId: 'test',
    generationGuard: { isCurrent: () => true } as any,
    retryClassifier: new DefaultRetryClassifier({} as any, () => 0),
    recoveryPolicy: new DefaultConversationRecoveryPolicy(),
    recoveryExecutor: {
      apply: (input: any) =>
        input.plan.kind === 'terminate' ? { kind: 'terminated', events: [] } : { kind: 'run', instruction: {} },
    } as any,
    retryEventPresenter: {
      present: () => ({ event: { type: 'retry_scheduled' }, logMessage: 'retry', logFields: {} }),
    } as any,
    resolveRetryLimit: () => 5,
    toolTracker: { activeCallIdsForCurrentTurn: () => [] } as any,
  });

  const state = createMockState({
    lastStream: {
      completed: Promise.resolve(undefined),
      output: [{ type: 'text_delta', text: 'partial answer already shown to the user' }],
      newItems: [],
    } as any,
  });
  const iterator = handler.handle({
    error: new Error('Codex WebSocket closed before a terminal response event.'),
    state,
  });
  let next = await iterator.next();
  while (!next.done) next = await iterator.next();

  expect((next.value as any).kind).toBe('terminated');
});
