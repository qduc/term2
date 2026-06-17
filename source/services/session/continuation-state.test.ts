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

  state.initializeFrom(prepared);

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

it('initializeFrom includes sibling interruption call IDs from the run state', () => {
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

  state.initializeFrom(prepared);

  expect(state.currentCallIds).toEqual(['call-1', 'call-2']);
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

  state.initializeFrom(prepared);
  expect(state.token).toBe(5);
});

it('advanceFromPlan updates state for next iteration', () => {
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

  expect(state.currentState).toBe(nextState);
  expect(state.currentCallIds).toEqual(['call-2']);
  expect(state.source).toBe('continueRunStream');
  expect(state.previouslyEmittedIds).toEqual(mergedIds);
  expect(state.inputMode).toBe('delta');
  expect(state.ledgerSnapshot).toEqual(snapshot);
});

it('advanceFromPlan includes sibling interruption call IDs from the next run state', () => {
  const state = new ContinuationState(1);
  state.initializeFrom({
    state: { id: 'run-1' } as any,
    interruption: { callId: 'call-1' },
    toolCallArgumentsById: new Map(),
    previouslyEmittedCommandIds: new Set<string>(),
    removeInterceptor: () => {},
    source: 'continueRunStream' as const,
  });

  const nextState = {
    getInterruptions: () => [{ callId: 'call-2' }, { call_id: 'call-3' }],
  } as any;

  state.advanceFromPlan(nextState, { callId: 'call-2' }, 'delta', new Set(), []);

  expect(state.currentCallIds).toEqual(['call-2', 'call-3']);
});

it('advanceFromPlan preserves inputMode when nextInputMode is undefined', () => {
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
  expect(state.inputMode).toBe('full_history');
});

it('initializeFrom includes tool output call IDs from generatedItems', () => {
  const state = new ContinuationState(5);
  const prepared = {
    state: {
      getInterruptions: () => [{ callId: 'call-1' }],
      generatedItems: [
        { type: 'tool_call_output_item', rawItem: { callId: 'call-2' } },
        { type: 'tool_call', rawItem: { callId: 'call-3' } },
      ],
    } as any,
    interruption: { callId: 'call-1' },
    toolCallArgumentsById: new Map(),
    previouslyEmittedCommandIds: new Set<string>(),
    removeInterceptor: () => {},
    source: 'continueRunStream' as const,
  };

  state.initializeFrom(prepared);

  expect(state.currentCallIds).toEqual(['call-1', 'call-2']);
});

it('initializeFrom includes generatedItems call IDs for all recognized tool result shapes', () => {
  const state = new ContinuationState(5);
  const prepared = {
    state: {
      generatedItems: [
        { type: 'function_call_output', callId: 'call-2' },
        { type: 'function_call_output_result', call_id: 'call-3' },
        { type: 'tool_call_output_item', rawItem: { callId: 'call-4' } },
      ],
    } as any,
    interruption: { callId: 'call-1' },
    toolCallArgumentsById: new Map(),
    previouslyEmittedCommandIds: new Set<string>(),
    removeInterceptor: () => {},
    source: 'continueRunStream' as const,
  };

  state.initializeFrom(prepared);

  expect(state.currentCallIds).toEqual(['call-1', 'call-2', 'call-3', 'call-4']);
});

it('advanceFromPlan includes tool output call IDs from generatedItems', () => {
  const state = new ContinuationState(1);
  state.initializeFrom({
    state: { id: 'run-1' } as any,
    interruption: { callId: 'call-1' },
    toolCallArgumentsById: new Map(),
    previouslyEmittedCommandIds: new Set<string>(),
    removeInterceptor: () => {},
    source: 'continueRunStream' as const,
  });

  const nextState = {
    getInterruptions: () => [{ callId: 'call-1' }],
    generatedItems: [{ type: 'tool_call_output_item', rawItem: { callId: 'call-2' } }],
  } as any;

  state.advanceFromPlan(nextState, { callId: 'call-1' }, 'delta', new Set(), []);

  expect(state.currentCallIds).toEqual(['call-1', 'call-2']);
});
