import { it, expect } from 'vitest';
import { ContinuationState } from './continuation-state.js';

it('ContinuationState initializes with default values', () => {
  const state = new ContinuationState(1);
  expect(state.token).toBe(1);
  expect(state.currentCallIds).toEqual([]);
  expect(state.source).toBe('continueRunStream');
  expect(state.previouslyEmittedIds).toEqual(new Set());
  expect(state.cumulativeCommandMessages).toEqual([]);
  expect(state.inputMode).toBe('delta');
  expect(state.lastStream).toBe(null);
  expect(state.currentResumePreviousResponseId).toBe(undefined);
  expect(state.retryCounts).toEqual({
    transientRetryCount: 0,
    serviceTierFallbackCount: 0,
    modelRetryCount: 0,
    transportDowngradeCount: 0,
  });
});

it('initializeFrom populates all fields from prepared continuation', () => {
  const state = new ContinuationState(5);
  const prepared = {
    state: { id: 'run-1' } as any,
    interruption: { callId: 'call-1' },
    toolCallArgumentsById: new Map(),
    previouslyEmittedCommandIds: new Set(['id-1']),
    removeInterceptor: () => {},
    source: 'abortResolution' as const,
    token: 7,
    inputMode: 'full_history' as const,
    cumulativeUsage: { promptTokens: 10 } as any,
    cumulativeCommandMessages: [{ id: 'msg-1', command: 'ls', output: 'out' } as any],
    cumulativeTurnItems: [{ type: 'text' } as any],
  };

  state.initializeFrom(prepared, ['call-1']);

  expect(state.token).toBe(7);
  expect(state.currentState).toBe(prepared.state);
  expect(state.currentCallIds).toEqual(['call-1']);
  expect(state.source).toBe('abortResolution');
  expect(state.previouslyEmittedIds).toEqual(new Set(['id-1']));
  expect(state.inputMode).toBe('full_history');
  expect(state.cumulativeUsage).toBe(prepared.cumulativeUsage);
  expect(state.cumulativeCommandMessages).toEqual(prepared.cumulativeCommandMessages);
  expect(state.cumulativeTurnItems).toEqual(prepared.cumulativeTurnItems);
});

it('initializeFrom uses the passed-in currentCallIds verbatim', () => {
  const state = new ContinuationState(5);
  const prepared = {
    state: { id: 'run-1' } as any,
    interruption: { callId: 'call-1' },
    toolCallArgumentsById: new Map(),
    previouslyEmittedCommandIds: new Set<string>(),
    removeInterceptor: () => {},
    source: 'continueRunStream' as const,
  };

  state.initializeFrom(prepared, ['call-a', 'call-b', 'call-c']);

  expect(state.currentCallIds).toEqual(['call-a', 'call-b', 'call-c']);
});

it('initializeFrom does not derive call IDs from the run state interruptions', () => {
  const state = new ContinuationState(5);
  const prepared = {
    state: {
      getInterruptions: () => [{ callId: 'call-1' }, { rawItem: { callId: 'call-2' } }],
    } as any,
    interruption: { callId: 'call-1' },
    toolCallArgumentsById: new Map(),
    previouslyEmittedCommandIds: new Set<string>(),
    removeInterceptor: () => {},
    source: 'continueRunStream' as const,
  };

  state.initializeFrom(prepared, ['ledger-only']);

  expect(state.currentCallIds).toEqual(['ledger-only']);
});

it('initializeFrom falls back to constructor token when prepared token is missing', () => {
  const state = new ContinuationState(5);
  const prepared = {
    state: { id: 'run-1' } as any,
    interruption: { callId: 'call-1' },
    toolCallArgumentsById: new Map(),
    previouslyEmittedCommandIds: new Set<string>(),
    removeInterceptor: () => {},
    source: 'continueRunStream' as const,
  };

  state.initializeFrom(prepared, ['call-1']);
  expect(state.token).toBe(5);
});

it('advanceFromPlan updates state for next iteration', () => {
  const state = new ContinuationState(1);
  state.initializeFrom(
    {
      state: { id: 'run-1' } as any,
      interruption: { callId: 'call-1' },
      toolCallArgumentsById: new Map(),
      previouslyEmittedCommandIds: new Set(['id-1']),
      removeInterceptor: () => {},
      source: 'abortResolution' as const,
    },
    ['call-1'],
  );

  const nextState = { id: 'run-2' } as any;
  const nextInterruption = { callId: 'call-2' };
  const mergedIds = new Set(['id-1', 'id-2']);
  const snapshot = [{ callId: 'call-1', status: 'completed' } as any];

  state.advanceFromPlan(nextState, nextInterruption, 'delta', mergedIds, snapshot, ['call-2']);

  expect(state.currentState).toBe(nextState);
  expect(state.currentCallIds).toEqual(['call-2']);
  expect(state.source).toBe('continueRunStream');
  expect(state.previouslyEmittedIds).toEqual(mergedIds);
  expect(state.inputMode).toBe('delta');
  expect(state.ledgerSnapshot).toEqual(snapshot);
});

it('advanceFromPlan uses the passed-in currentCallIds (superset from ledger)', () => {
  const state = new ContinuationState(1);
  state.initializeFrom(
    {
      state: { id: 'run-1' } as any,
      interruption: { callId: 'call-1' },
      toolCallArgumentsById: new Map(),
      previouslyEmittedCommandIds: new Set<string>(),
      removeInterceptor: () => {},
      source: 'continueRunStream' as const,
    },
    ['call-1'],
  );

  const nextState = {
    getInterruptions: () => [{ callId: 'call-2' }, { call_id: 'call-3' }],
  } as any;

  // The ledger superset includes call-1 (prior cycle) plus call-2/call-3.
  state.advanceFromPlan(nextState, { callId: 'call-2' }, 'delta', new Set(), [], ['call-1', 'call-2', 'call-3']);

  expect(state.currentCallIds).toEqual(['call-1', 'call-2', 'call-3']);
});

it('advanceFromPlan preserves inputMode when nextInputMode is undefined', () => {
  const state = new ContinuationState(1);
  state.initializeFrom(
    {
      state: { id: 'run-1' } as any,
      interruption: { callId: 'call-1' },
      toolCallArgumentsById: new Map(),
      previouslyEmittedCommandIds: new Set<string>(),
      removeInterceptor: () => {},
      source: 'continueRunStream' as const,
      inputMode: 'full_history',
    },
    ['call-1'],
  );

  state.advanceFromPlan({ id: 'run-2' } as any, { callId: 'call-2' }, undefined, new Set(), [], ['call-2']);
  expect(state.inputMode).toBe('full_history');
});
