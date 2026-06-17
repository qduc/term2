import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { collectDuplicateToolCallResultPairs, collectInputSurgeStats, InputSurgeGuard } from './input-surge-guard.js';

const toolCall = (callId: string, type = 'function_call') => ({
  type,
  callId,
});

it('collectInputSurgeStats counts messages and duplicated tool-call signatures', () => {
  const stats = collectInputSurgeStats([
    { role: 'user', type: 'message', content: 'hello' },
    toolCall('call-1'),
    toolCall('call-1'),
    toolCall('call-1', 'function_call_result'),
    toolCall('call-1', 'function_call_result'),
    toolCall('call-2'),
  ]);

  expect(stats).toEqual({
    messageCount: 6,
    totalSerializedBytes: 281,
    duplicateToolCallSignatures: 2,
    maxDuplicateToolCallSignatureCount: 2,
  });
});

it('InputSurgeGuard allows abrupt message-count growth from last successful input', () => {
  const guard = new InputSurgeGuard();
  guard.recordSuccessfulInput(Array.from({ length: 65 }, (_, index) => ({ role: 'user', content: `m${index}` })));

  const decision = guard.inspect(Array.from({ length: 863 }, (_, index) => ({ role: 'user', content: `m${index}` })));

  expect(decision.action).toBe('allow');
});

it('InputSurgeGuard allows abrupt serialized byte growth from last successful input', () => {
  const guard = new InputSurgeGuard();
  guard.recordSuccessfulInput([{ role: 'user', type: 'message', content: 'small' }]);

  const decision = guard.inspect([{ type: 'function_call_result', callId: 'call-1', output: 'x'.repeat(150_000) }]);

  expect(decision.action).toBe('allow');
});

it('InputSurgeGuard allows large absolute growth below the minimum surge threshold', () => {
  const guard = new InputSurgeGuard();
  guard.recordSuccessfulInput(Array.from({ length: 1 }, (_, index) => ({ role: 'user', content: `m${index}` })));

  const decision = guard.inspect(Array.from({ length: 65 }, (_, index) => ({ role: 'user', content: `m${index}` })));

  expect(decision.action).toBe('allow');
});

it('InputSurgeGuard blocks replayed tool-call signatures', () => {
  const guard = new InputSurgeGuard();
  const input: unknown[] = [];

  for (let call = 0; call < 20; call++) {
    for (let repetition = 0; repetition < 4; repetition++) {
      input.push(toolCall(`call-${call}`));
    }
  }

  const decision = guard.inspect(input);

  expect(decision.action).toBe('block');
  expect(decision.reason?.includes('replayed tool-call history')).toBe(true);
});

it('InputSurgeGuard ignores recorded input from other input kinds', () => {
  const guard = new InputSurgeGuard();
  guard.recordSuccessfulInput([{ role: 'user', type: 'message', content: 'small delta' }], { kind: 'delta' });

  const decision = guard.inspect(
    Array.from({ length: 212 }, (_, index) => ({ role: 'user', type: 'message', content: `history-${index}` })),
    { kind: 'full_history' },
  );

  expect(decision.action).toBe('allow');
  expect(decision.previousStats).toBe(undefined);
});

it('InputSurgeGuard blocks duplicate tool call and result pairs at two copies', () => {
  const guard = new InputSurgeGuard();
  const pair = (callId: string) => [
    toolCall(callId),
    { type: 'function_call_result', callId, output: { type: 'text', text: `result-${callId}` } },
  ];

  const decision = guard.inspect([
    ...pair('call-1'),
    ...pair('call-2'),
    ...pair('call-3'),
    ...pair('call-1'),
    ...pair('call-2'),
    ...pair('call-3'),
  ]);

  expect(decision.action).toBe('block');
  expect(decision.reason?.includes('tool call/result pairs')).toBe(true);
});

it('collectDuplicateToolCallResultPairs reports duplicated call/result pairs without content', () => {
  const input = [
    toolCall('call-1'),
    { type: 'function_call_result', callId: 'call-1', output: { text: 'secret' } },
    toolCall('call-1'),
    { type: 'function_call_result', callId: 'call-1', output: { text: 'secret again' } },
    toolCall('call-2'),
    { type: 'function_call_result', callId: 'call-2', output: { text: 'single' } },
  ];

  expect(collectDuplicateToolCallResultPairs(input)).toEqual({
    pairs: 1,
    maxCopies: 2,
  });
});

it('InputSurgeGuard allows a large tool result appended after a successful full-history request', () => {
  const guard = new InputSurgeGuard();
  const requestHistory = [{ role: 'user', type: 'message', content: 'inspect files' }];
  const postRunHistory = [
    ...requestHistory,
    toolCall('call-large'),
    { type: 'function_call_result', callId: 'call-large', output: 'x'.repeat(150_000) },
  ];

  guard.recordSuccessfulInput(postRunHistory, { kind: 'full_history', previousInput: requestHistory });

  const decision = guard.inspect([...postRunHistory, { role: 'user', type: 'message', content: 'follow up' }], {
    kind: 'full_history',
  });

  expect(decision.action).toBe('allow');
});

it('InputSurgeGuard recordSuccessfulInput does not create a size-growth block', () => {
  const guard = new InputSurgeGuard();
  guard.recordSuccessfulInput(Array.from({ length: 65 }, (_, index) => ({ role: 'user', content: `m${index}` })));

  const largeInput = Array.from({ length: 863 }, (_, index) => ({ role: 'user', content: `m${index}` }));
  expect(guard.inspect(largeInput).action).toBe('allow');
});

it('InputSurgeGuard does not defer a block after recording a large tool result', () => {
  const guard = new InputSurgeGuard();
  const requestHistory = [{ role: 'user', type: 'message', content: 'first query' }];
  const postRunHistory = [
    ...requestHistory,
    { type: 'function_call', callId: 'call-large' },
    { type: 'function_call_result', callId: 'call-large', output: 'x'.repeat(150_000) },
  ];

  guard.recordSuccessfulInput(postRunHistory, { kind: 'full_history', previousInput: requestHistory });

  const firstDecision = guard.inspect([...postRunHistory, { role: 'user', content: 'follow up' }], {
    kind: 'full_history',
  });
  expect(firstDecision.action).toBe('allow');

  const secondDecision = guard.inspect([...postRunHistory, { role: 'user', content: 'another follow up' }], {
    kind: 'full_history',
  });
  expect(secondDecision.action).toBe('allow');
});
