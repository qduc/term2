import test from 'ava';
import { ContinuationState } from './continuation-state.js';

test('ContinuationState initializes with default values', (t) => {
  const state = new ContinuationState(1);
  t.is(state.token, 1);
  t.deepEqual(state.currentCallIds, []);
  t.is(state.source, 'continueRunStream');
  t.deepEqual(state.previouslyEmittedIds, new Set());
  t.deepEqual(state.cumulativeCommandMessages, []);
  t.is(state.inputMode, 'delta');
  t.is(state.lastStream, null);
  t.is(state.currentResumePreviousResponseId, undefined);
  t.deepEqual(state.retryCounts, {
    transientRetryCount: 0,
    serviceTierFallbackCount: 0,
    modelRetryCount: 0,
    transportDowngradeCount: 0,
  });
});

test('initializeFrom populates all fields from prepared continuation', (t) => {
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

  state.initializeFrom(prepared);

  t.is(state.token, 7);
  t.is(state.currentState, prepared.state);
  t.deepEqual(state.currentCallIds, ['call-1']);
  t.is(state.source, 'abortResolution');
  t.deepEqual(state.previouslyEmittedIds, new Set(['id-1']));
  t.is(state.inputMode, 'full_history');
  t.is(state.cumulativeUsage, prepared.cumulativeUsage);
  t.deepEqual(state.cumulativeCommandMessages, prepared.cumulativeCommandMessages);
  t.deepEqual(state.cumulativeTurnItems, prepared.cumulativeTurnItems);
});

test('initializeFrom falls back to constructor token when prepared token is missing', (t) => {
  const state = new ContinuationState(5);
  const prepared = {
    state: { id: 'run-1' } as any,
    interruption: { callId: 'call-1' },
    toolCallArgumentsById: new Map(),
    previouslyEmittedCommandIds: new Set<string>(),
    removeInterceptor: () => {},
    source: 'continueRunStream' as const,
  };

  state.initializeFrom(prepared);
  t.is(state.token, 5);
});

test('advanceFromPlan updates state for next iteration', (t) => {
  const state = new ContinuationState(1);
  state.initializeFrom({
    state: { id: 'run-1' } as any,
    interruption: { callId: 'call-1' },
    toolCallArgumentsById: new Map(),
    previouslyEmittedCommandIds: new Set(['id-1']),
    removeInterceptor: () => {},
    source: 'abortResolution' as const,
  });

  const nextState = { id: 'run-2' } as any;
  const nextInterruption = { callId: 'call-2' };
  const mergedIds = new Set(['id-1', 'id-2']);
  const snapshot = [{ callId: 'call-1', status: 'completed' } as any];

  state.advanceFromPlan(nextState, nextInterruption, 'delta', mergedIds, snapshot);

  t.is(state.currentState, nextState);
  t.deepEqual(state.currentCallIds, ['call-2']);
  t.is(state.source, 'continueRunStream');
  t.deepEqual(state.previouslyEmittedIds, mergedIds);
  t.is(state.inputMode, 'delta');
  t.deepEqual(state.ledgerSnapshot, snapshot);
});

test('advanceFromPlan preserves inputMode when nextInputMode is undefined', (t) => {
  const state = new ContinuationState(1);
  state.initializeFrom({
    state: { id: 'run-1' } as any,
    interruption: { callId: 'call-1' },
    toolCallArgumentsById: new Map(),
    previouslyEmittedCommandIds: new Set<string>(),
    removeInterceptor: () => {},
    source: 'continueRunStream' as const,
    inputMode: 'full_history',
  });

  state.advanceFromPlan({ id: 'run-2' } as any, { callId: 'call-2' }, undefined, new Set(), []);
  t.is(state.inputMode, 'full_history');
});
