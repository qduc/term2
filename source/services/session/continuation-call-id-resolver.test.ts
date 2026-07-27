import { expect, it } from 'vitest';
import {
  collectKnownToolCallIds,
  resolveAbortedApprovalCallIds,
  resolveResponseCycleCallIds,
} from './continuation-call-id-resolver.js';

it('deduplicates interrupted and completed response-cycle call ids', () => {
  const result = resolveResponseCycleCallIds({
    interruptionCallIds: ['call-1'],
    completedResultCallIds: ['call-1', 'call-2'],
    fallbackCallIds: ['fallback'],
    conversationHistory: [],
  });

  expect(result).toEqual(['call-1', 'call-2']);
});

it('excludes completed outputs already represented in history', () => {
  const result = resolveResponseCycleCallIds({
    interruptionCallIds: ['call-current'],
    completedResultCallIds: ['call-consumed', 'call-new'],
    fallbackCallIds: [],
    conversationHistory: [{ type: 'function_call_output', callId: 'call-consumed' }],
  });

  expect(result).toEqual(['call-current', 'call-new']);
});

it('preserves fallback ids only when the response-cycle caller requests them', () => {
  const input = {
    interruptionCallIds: ['call-new'],
    completedResultCallIds: [],
    fallbackCallIds: ['call-approved'],
    conversationHistory: [],
  };

  expect(resolveResponseCycleCallIds(input)).toEqual(['call-new']);
  expect(resolveResponseCycleCallIds({ ...input, preserveFallback: true })).toEqual(['call-approved', 'call-new']);
});

it('falls back when no response-cycle ids can be resolved', () => {
  expect(
    resolveResponseCycleCallIds({
      interruptionCallIds: [],
      completedResultCallIds: [],
      fallbackCallIds: ['call-fallback'],
      conversationHistory: [],
    }),
  ).toEqual(['call-fallback']);
});

it('keeps interrupted and completed sibling ids during abort resolution', () => {
  const result = resolveAbortedApprovalCallIds({
    interruptionCallIds: ['call-rejected'],
    completedResultCallIds: ['call-approved'],
  });

  expect(result).toEqual(['call-rejected', 'call-approved']);
});

it('collects tool-call ids of every call shape in history', () => {
  const history = [
    { role: 'user', content: 'hi' },
    { type: 'function_call', callId: 'call-fn', name: 'grep', arguments: '{}' },
    { type: 'local_shell_call', callId: 'call-shell' },
    { type: 'function_call_output', callId: 'call-fn', output: 'done' },
  ];

  expect(collectKnownToolCallIds(history)).toEqual(['call-fn', 'call-shell']);
});

it('collects no ids from history holding only tool outputs', () => {
  const history = [{ type: 'function_call_output', callId: 'call-orphan', output: 'done' }];

  expect(collectKnownToolCallIds(history)).toEqual([]);
});
