import test from 'ava';
import { TurnAttempt } from './turn-attempt.js';
import type { RetryCounts } from '../retry/retry-contracts.js';
import type { SavedToolExecution } from '../tool-execution-ledger.js';
import type { UserTurn } from '../../types/user-turn.js';
import type { AgentStream } from '../agent-stream.js';
import { MockStream } from '../test-helpers/mock-stream.js';

const mockTurn: UserTurn = { text: 'test turn' };
const mockLedger: SavedToolExecution[] = [
  {
    turnId: 'turn-1',
    callId: 'call_1',
    toolName: 'tool_1',
    arguments: '{}',
    status: 'started',
    startedAt: new Date().toISOString(),
  },
];
const mockRetryCounts: RetryCounts = {
  transientRetryCount: 0,
  serviceTierFallbackCount: 0,
  modelRetryCount: 0,
  transportDowngradeCount: 0,
};

test('TurnAttempt construction and getters', (t) => {
  const attempt = new TurnAttempt({
    turn: mockTurn,
    token: 42,
    initialRetryCounts: mockRetryCounts,
    initialLedgerSnapshot: mockLedger,
    maxTransientRetries: 3,
    maxModelRetries: 5,
  });

  t.is(attempt.turn, mockTurn);
  t.is(attempt.token, 42);
  t.deepEqual(attempt.initialRetryCounts, mockRetryCounts);
  t.deepEqual(attempt.initialLedgerSnapshot, mockLedger);
  t.is(attempt.maxTransientRetries, 3);
  t.is(attempt.maxModelRetries, 5);
  t.deepEqual(attempt.retryCounts, mockRetryCounts);
  t.is(attempt.stream, null);
  t.is(attempt.streamInput, undefined);
  t.is(attempt.inputMode, undefined);
  t.is(attempt.addedUserMessage, false);
  t.is(attempt.closed, false);
});

test('markUserMessageAdded sets addedUserMessage to true', (t) => {
  const attempt = new TurnAttempt({
    turn: mockTurn,
    token: 1,
    initialRetryCounts: mockRetryCounts,
    initialLedgerSnapshot: [],
    maxTransientRetries: 3,
  });

  t.is(attempt.addedUserMessage, false);
  attempt.markUserMessageAdded();
  t.is(attempt.addedUserMessage, true);
});

test('attachInput sets streamInput and inputMode', (t) => {
  const attempt = new TurnAttempt({
    turn: mockTurn,
    token: 1,
    initialRetryCounts: mockRetryCounts,
    initialLedgerSnapshot: [],
    maxTransientRetries: 3,
  });

  attempt.attachInput({
    streamInput: 'planned-input',
    inputSurgeKind: 'delta',
    effectiveTurn: mockTurn,
  });

  t.is(attempt.streamInput, 'planned-input');
  t.is(attempt.inputMode, 'delta');
});

test('attachStream updates the current stream reference', (t) => {
  const attempt = new TurnAttempt({
    turn: mockTurn,
    token: 1,
    initialRetryCounts: mockRetryCounts,
    initialLedgerSnapshot: [],
    maxTransientRetries: 3,
  });

  const stream = new MockStream([]) as unknown as AgentStream;
  attempt.attachStream(stream);
  t.is(attempt.stream, stream);

  attempt.attachStream(null);
  t.is(attempt.stream, null);
});

test('advanceRetry updates retryCounts without replacing initial snapshot', (t) => {
  const attempt = new TurnAttempt({
    turn: mockTurn,
    token: 1,
    initialRetryCounts: mockRetryCounts,
    initialLedgerSnapshot: mockLedger,
    maxTransientRetries: 3,
  });

  const nextCounts: RetryCounts = {
    transientRetryCount: 1,
    serviceTierFallbackCount: 0,
    modelRetryCount: 0,
    transportDowngradeCount: 0,
  };

  attempt.advanceRetry(nextCounts);

  t.deepEqual(attempt.retryCounts, nextCounts);
  t.deepEqual(attempt.initialRetryCounts, mockRetryCounts);
  t.deepEqual(attempt.initialLedgerSnapshot, mockLedger);
});

test('close is idempotent and removes abort listener', (t) => {
  let abortCalledCount = 0;
  const controller = new AbortController();
  const attempt = new TurnAttempt({
    turn: mockTurn,
    token: 1,
    initialRetryCounts: mockRetryCounts,
    initialLedgerSnapshot: [],
    maxTransientRetries: 3,
    signal: controller.signal,
    onAbort: () => {
      abortCalledCount++;
    },
  });

  t.is(attempt.closed, false);

  // Close the attempt
  attempt.close();
  t.is(attempt.closed, true);

  // Trigger abort after close
  controller.abort();
  t.is(abortCalledCount, 0, 'onAbort should not be called after close()');

  // Idempotent close - should not throw or change anything
  t.notThrows(() => attempt.close());
  t.is(attempt.closed, true);
});

test('constructor throws AbortError for already-aborted signal', (t) => {
  const controller = new AbortController();
  controller.abort();

  let abortCalledCount = 0;

  t.throws(
    () => {
      new TurnAttempt({
        turn: mockTurn,
        token: 1,
        initialRetryCounts: mockRetryCounts,
        initialLedgerSnapshot: [],
        maxTransientRetries: 3,
        signal: controller.signal,
        onAbort: () => {
          abortCalledCount++;
        },
      });
    },
    { name: 'AbortError', message: 'Operation aborted' },
  );

  t.is(abortCalledCount, 1, 'onAbort should be called if already aborted');
});

test('onAbort is called when signal is aborted later', (t) => {
  const controller = new AbortController();
  let abortCalledCount = 0;

  const attempt = new TurnAttempt({
    turn: mockTurn,
    token: 1,
    initialRetryCounts: mockRetryCounts,
    initialLedgerSnapshot: [],
    maxTransientRetries: 3,
    signal: controller.signal,
    onAbort: () => {
      abortCalledCount++;
    },
  });

  t.is(abortCalledCount, 0);
  controller.abort();
  t.is(abortCalledCount, 1);

  attempt.close();
});
