import { expect, it } from 'vitest';
import { resolveAbortedApprovalCallIds, resolveResponseCycleCallIds } from './continuation-call-id-resolver.js';

it('deduplicates interrupted and generated response-cycle call ids', () => {
  const result = resolveResponseCycleCallIds({
    runState: {
      getInterruptions: () => [{ callId: 'call-1' }],
      _generatedItems: [
        { type: 'function_call_output', callId: 'call-1' },
        { rawItem: { type: 'function_call_output', callId: 'call-2' } },
      ],
    },
    primaryInterruption: { callId: 'call-1' },
    fallbackCallIds: ['fallback'],
    conversationHistory: [],
  });

  expect(result).toEqual(['call-1', 'call-2']);
});

it('excludes generated outputs already represented in history', () => {
  const result = resolveResponseCycleCallIds({
    runState: {
      getInterruptions: () => [{ callId: 'call-current' }],
      _generatedItems: [
        { type: 'function_call_output', callId: 'call-consumed' },
        { type: 'function_call_output', callId: 'call-new' },
      ],
    },
    primaryInterruption: undefined,
    fallbackCallIds: [],
    conversationHistory: [{ type: 'function_call_output', callId: 'call-consumed' }],
  });

  expect(result).toEqual(['call-current', 'call-new']);
});

it('preserves fallback ids only when the response-cycle caller requests them', () => {
  const input = {
    runState: { getInterruptions: () => [{ callId: 'call-new' }] },
    primaryInterruption: undefined,
    fallbackCallIds: ['call-approved'],
    conversationHistory: [],
  };

  expect(resolveResponseCycleCallIds(input)).toEqual(['call-new']);
  expect(resolveResponseCycleCallIds({ ...input, preserveFallback: true })).toEqual(['call-approved', 'call-new']);
});

it('falls back when no response-cycle ids can be resolved', () => {
  expect(
    resolveResponseCycleCallIds({
      runState: {},
      primaryInterruption: undefined,
      fallbackCallIds: ['call-fallback'],
      conversationHistory: [],
    }),
  ).toEqual(['call-fallback']);
});

it('keeps interrupted and completed sibling ids during abort resolution', () => {
  const result = resolveAbortedApprovalCallIds({
    runState: {
      getInterruptions: () => [{ callId: 'call-rejected' }],
      _generatedItems: [{ type: 'function_call_output', callId: 'call-approved' }],
    },
    primaryInterruption: { callId: 'call-rejected' },
  });

  expect(result).toEqual(['call-rejected', 'call-approved']);
});
