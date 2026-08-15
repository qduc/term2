import { it, expect, vi } from 'vitest';
import { InitialTurnRecoveryHandler } from './initial-turn-recovery-handler.js';
import { TurnAttempt } from './turn-attempt.js';
import { CodexResponsesTransport, CodexResponsesWSModel } from '../../providers/codex-responses-model.js';
import { AmbiguousModelOutcomeError } from '../retry/retry-errors.js';
import { DefaultConversationRecoveryPolicy } from '../retry/recovery-policy.js';
import { DefaultRetryClassifier } from '../retry/retry-classifier.js';

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

it.fails(
  'characterizes the unimplemented watchdog timeout fallback at the initial-turn recovery boundary',
  async () => {
    vi.useFakeTimers();
    try {
      const transport = new CodexResponsesTransport({} as any, 'gpt-5-codex', false);
      transport.fetchResponse = async (request: any) => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise((_, reject) => {
              request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
            }),
          return: async () => ({ done: true, value: undefined }),
        }),
      });
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
      const error = await pending.catch((reason) => reason);
      expect(error).toBeInstanceOf(AmbiguousModelOutcomeError);

      const handler = new InitialTurnRecoveryHandler({
        conversationStore: { getHistory: () => [] } as any,
        freshStartRetriesAllowed: true,
        generationGuard: { isCurrent: () => true } as any,
        inputPlanner: { recordSuccess: () => {} } as any,
        logger: { warn: () => {}, error: () => {}, getCorrelationId: () => undefined } as any,
        recoveryExecutor: {
          apply: ({ plan }: any) => {
            // Intended behavior, deliberately retained as a red proof: a
            // trustworthy unsent watchdog timeout would permit a fresh,
            // full-history retry after transport rebind. Today the ambiguous
            // outcome safely reaches this seam as `terminate` instead.
            expect(plan).toEqual({ kind: 'retry_fresh', inputMode: 'full_history' });
            return { kind: 'run', instruction: { skipUserMessage: true }, events: [] };
          },
        } as any,
        recoveryPolicy: new DefaultConversationRecoveryPolicy(),
        retryClassifier: new DefaultRetryClassifier({} as any, () => 0),
        retryEventPresenter: { present: () => ({ event: {}, logMessage: '', logFields: {} }) } as any,
        sessionId: 'watchdog-characterization',
      });

      await handler.handle({ error, attempt: createAttempt(), stream: null }).next();
    } finally {
      vi.useRealTimers();
    }
  },
);

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
  expect(attempt.retryCounts).toEqual(nextCounts);
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
