import test from 'ava';
import { collectDuplicateToolCallResultPairs, collectInputSurgeStats, InputSurgeGuard } from './input-surge-guard.js';

const toolCall = (callId: string, type = 'function_call') => ({
  type,
  callId,
});

test('collectInputSurgeStats counts messages and duplicated tool-call signatures', (t) => {
  const stats = collectInputSurgeStats([
    { role: 'user', type: 'message', content: 'hello' },
    toolCall('call-1'),
    toolCall('call-1'),
    toolCall('call-1', 'function_call_result'),
    toolCall('call-1', 'function_call_result'),
    toolCall('call-2'),
  ]);

  t.deepEqual(stats, {
    messageCount: 6,
    totalSerializedBytes: 281,
    duplicateToolCallSignatures: 2,
    maxDuplicateToolCallSignatureCount: 2,
  });
});

test('InputSurgeGuard allows abrupt message-count growth from last successful input', (t) => {
  const guard = new InputSurgeGuard();
  guard.recordSuccessfulInput(Array.from({ length: 65 }, (_, index) => ({ role: 'user', content: `m${index}` })));

  const decision = guard.inspect(Array.from({ length: 863 }, (_, index) => ({ role: 'user', content: `m${index}` })));

  t.is(decision.action, 'allow');
});

test('InputSurgeGuard allows abrupt serialized byte growth from last successful input', (t) => {
  const guard = new InputSurgeGuard();
  guard.recordSuccessfulInput([{ role: 'user', type: 'message', content: 'small' }]);

  const decision = guard.inspect([{ type: 'function_call_result', callId: 'call-1', output: 'x'.repeat(150_000) }]);

  t.is(decision.action, 'allow');
});

test('InputSurgeGuard allows large absolute growth below the minimum surge threshold', (t) => {
  const guard = new InputSurgeGuard();
  guard.recordSuccessfulInput(Array.from({ length: 1 }, (_, index) => ({ role: 'user', content: `m${index}` })));

  const decision = guard.inspect(Array.from({ length: 65 }, (_, index) => ({ role: 'user', content: `m${index}` })));

  t.is(decision.action, 'allow');
});

test('InputSurgeGuard blocks replayed tool-call signatures', (t) => {
  const guard = new InputSurgeGuard();
  const input: unknown[] = [];

  for (let call = 0; call < 20; call++) {
    for (let repetition = 0; repetition < 4; repetition++) {
      input.push(toolCall(`call-${call}`));
    }
  }

  const decision = guard.inspect(input);

  t.is(decision.action, 'block');
  t.true(decision.reason?.includes('replayed tool-call history'));
});

test('InputSurgeGuard ignores recorded input from other input kinds', (t) => {
  const guard = new InputSurgeGuard();
  guard.recordSuccessfulInput([{ role: 'user', type: 'message', content: 'small delta' }], { kind: 'delta' });

  const decision = guard.inspect(
    Array.from({ length: 212 }, (_, index) => ({ role: 'user', type: 'message', content: `history-${index}` })),
    { kind: 'full_history' },
  );

  t.is(decision.action, 'allow');
  t.is(decision.previousStats, undefined);
});

test('InputSurgeGuard blocks duplicate tool call and result pairs at two copies', (t) => {
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

  t.is(decision.action, 'block');
  t.true(decision.reason?.includes('tool call/result pairs'));
});

test('collectDuplicateToolCallResultPairs reports duplicated call/result pairs without content', (t) => {
  const input = [
    toolCall('call-1'),
    { type: 'function_call_result', callId: 'call-1', output: { text: 'secret' } },
    toolCall('call-1'),
    { type: 'function_call_result', callId: 'call-1', output: { text: 'secret again' } },
    toolCall('call-2'),
    { type: 'function_call_result', callId: 'call-2', output: { text: 'single' } },
  ];

  t.deepEqual(collectDuplicateToolCallResultPairs(input), {
    pairs: 1,
    maxCopies: 2,
  });
});

test('InputSurgeGuard allows a large tool result appended after a successful full-history request', (t) => {
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

  t.is(decision.action, 'allow');
});

test('InputSurgeGuard recordSuccessfulInput does not create a size-growth block', (t) => {
  const guard = new InputSurgeGuard();
  guard.recordSuccessfulInput(Array.from({ length: 65 }, (_, index) => ({ role: 'user', content: `m${index}` })));

  const largeInput = Array.from({ length: 863 }, (_, index) => ({ role: 'user', content: `m${index}` }));
  t.is(guard.inspect(largeInput).action, 'allow');
});

test('InputSurgeGuard does not defer a block after recording a large tool result', (t) => {
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
  t.is(firstDecision.action, 'allow');

  const secondDecision = guard.inspect([...postRunHistory, { role: 'user', content: 'another follow up' }], {
    kind: 'full_history',
  });
  t.is(secondDecision.action, 'allow');
});
