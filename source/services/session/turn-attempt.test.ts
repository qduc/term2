import { it, expect } from 'vitest';
import { TurnAttempt } from './turn-attempt.js';
import type { RetryCounts } from '../retry/retry-contracts.js';
import type { AssistantJournalItemLogEvent } from '../logging/conversation-log-events.js';
import type { UserTurn } from '../../types/user-turn.js';
import type { AgentStream } from '../agent-stream.js';
import { MockStream } from '../test-helpers/mock-stream.js';

const mockTurn: UserTurn = { text: 'test turn' };
const mockJournalSnapshot: AssistantJournalItemLogEvent[] = [
  {
    type: 'assistant_journal_item',
    turnId: 'turn-1',
    seq: 1,
    item: {
      type: 'tool_call',
      callId: 'call_1',
      toolName: 'tool_1',
      arguments: '{}',
    },
  },
];
const mockRetryCounts: RetryCounts = {
  transientRetryCount: 0,
  serviceTierFallbackCount: 0,
  modelRetryCount: 0,
  transportDowngradeCount: 0,
};

it('TurnAttempt construction and getters', () => {
  const attempt = new TurnAttempt({
    turn: mockTurn,
    token: 42,
    initialRetryCounts: mockRetryCounts,
    initialJournalSnapshot: mockJournalSnapshot,
    maxTransientRetries: 3,
    maxModelRetries: 5,
  });

  expect(attempt.turn).toBe(mockTurn);
  expect(attempt.token).toBe(42);
  expect(attempt.initialRetryCounts).toEqual(mockRetryCounts);
  expect(attempt.initialJournalSnapshot).toEqual(mockJournalSnapshot);
  expect(attempt.maxTransientRetries).toBe(3);
  expect(attempt.maxModelRetries).toBe(5);
  expect(attempt.retryCounts).toEqual(mockRetryCounts);
  expect(attempt.stream).toBe(null);
  expect(attempt.streamInput).toBe(undefined);
  expect(attempt.inputMode).toBe(undefined);
  expect(attempt.addedUserMessage).toBe(false);
  expect(attempt.closed).toBe(false);
});

it('markUserMessageAdded sets addedUserMessage to true', () => {
  const attempt = new TurnAttempt({
    turn: mockTurn,
    token: 1,
    initialRetryCounts: mockRetryCounts,
    initialJournalSnapshot: [],
    maxTransientRetries: 3,
  });

  expect(attempt.addedUserMessage).toBe(false);
  attempt.markUserMessageAdded();
  expect(attempt.addedUserMessage).toBe(true);
});

it('attachInput sets streamInput and inputMode', () => {
  const attempt = new TurnAttempt({
    turn: mockTurn,
    token: 1,
    initialRetryCounts: mockRetryCounts,
    initialJournalSnapshot: [],
    maxTransientRetries: 3,
  });

  attempt.attachInput({
    streamInput: 'planned-input',
    inputSurgeKind: 'delta',
    effectiveTurn: mockTurn,
  });

  expect(attempt.streamInput).toBe('planned-input');
  expect(attempt.inputMode).toBe('delta');
});

it('attachStream updates the current stream reference', () => {
  const attempt = new TurnAttempt({
    turn: mockTurn,
    token: 1,
    initialRetryCounts: mockRetryCounts,
    initialJournalSnapshot: [],
    maxTransientRetries: 3,
  });

  const stream = new MockStream([]) as unknown as AgentStream;
  attempt.attachStream(stream);
  expect(attempt.stream).toBe(stream);

  attempt.attachStream(null);
  expect(attempt.stream).toBe(null);
});

it('advanceRetry updates retryCounts without replacing initial snapshot', () => {
  const attempt = new TurnAttempt({
    turn: mockTurn,
    token: 1,
    initialRetryCounts: mockRetryCounts,
    initialJournalSnapshot: mockJournalSnapshot,
    maxTransientRetries: 3,
  });

  const nextCounts: RetryCounts = {
    transientRetryCount: 1,
    serviceTierFallbackCount: 0,
    modelRetryCount: 0,
    transportDowngradeCount: 0,
  };

  attempt.advanceRetry(nextCounts);

  expect(attempt.retryCounts).toEqual(nextCounts);
  expect(attempt.initialRetryCounts).toEqual(mockRetryCounts);
  expect(attempt.initialJournalSnapshot).toEqual(mockJournalSnapshot);
});

it('close is idempotent and removes abort listener', () => {
  let abortCalledCount = 0;
  const controller = new AbortController();
  const attempt = new TurnAttempt({
    turn: mockTurn,
    token: 1,
    initialRetryCounts: mockRetryCounts,
    initialJournalSnapshot: [],
    maxTransientRetries: 3,
    signal: controller.signal,
    onAbort: () => {
      abortCalledCount++;
    },
  });

  expect(attempt.closed).toBe(false);

  // Close the attempt
  attempt.close();
  expect(attempt.closed).toBe(true);

  // Trigger abort after close
  controller.abort();
  expect(abortCalledCount, 'onAbort should not be called after close()').toBe(0);

  // Idempotent close - should not throw or change anything
  expect(() => attempt.close());
  expect(attempt.closed).toBe(true);
});

it('constructor throws AbortError for already-aborted signal', () => {
  const controller = new AbortController();
  controller.abort();

  let abortCalledCount = 0;

  expect(() => {
    new TurnAttempt({
      turn: mockTurn,
      token: 1,
      initialRetryCounts: mockRetryCounts,
      initialJournalSnapshot: [],
      maxTransientRetries: 3,
      signal: controller.signal,
      onAbort: () => {
        abortCalledCount++;
      },
    });
  }).toThrow('Operation aborted');

  expect(abortCalledCount, 'onAbort should be called if already aborted').toBe(1);
});

it('onAbort is called when signal is aborted later', () => {
  const controller = new AbortController();
  let abortCalledCount = 0;

  const attempt = new TurnAttempt({
    turn: mockTurn,
    token: 1,
    initialRetryCounts: mockRetryCounts,
    initialJournalSnapshot: [],
    maxTransientRetries: 3,
    signal: controller.signal,
    onAbort: () => {
      abortCalledCount++;
    },
  });

  expect(abortCalledCount).toBe(0);
  controller.abort();
  expect(abortCalledCount).toBe(1);

  attempt.close();
});
