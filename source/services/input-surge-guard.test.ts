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

test('InputSurgeGuard blocks abrupt message-count growth from last successful input', (t) => {
  const guard = new InputSurgeGuard();
  guard.recordSuccessfulInput(Array.from({ length: 65 }, (_, index) => ({ role: 'user', content: `m${index}` })));

  const decision = guard.inspect(Array.from({ length: 863 }, (_, index) => ({ role: 'user', content: `m${index}` })));

  t.is(decision.action, 'block');
  t.true(decision.reason?.includes('65 to 863'));
});

test('InputSurgeGuard blocks abrupt serialized byte growth from last successful input', (t) => {
  const guard = new InputSurgeGuard();
  guard.recordSuccessfulInput([{ role: 'user', type: 'message', content: 'small' }]);

  const decision = guard.inspect([{ type: 'function_call_result', callId: 'call-1', output: 'x'.repeat(150_000) }]);

  t.is(decision.action, 'block');
  t.true(decision.reason?.includes('input size jumped'));
});

test('InputSurgeGuard allows large absolute growth below the minimum surge threshold', (t) => {
  const guard = new InputSurgeGuard();
  guard.recordSuccessfulInput(Array.from({ length: 1 }, (_, index) => ({ role: 'user', content: `m${index}` })));

  const decision = guard.inspect(Array.from({ length: 65 }, (_, index) => ({ role: 'user', content: `m${index}` })));

  t.is(decision.action, 'allow');
});

test('InputSurgeGuard blocks replayed tool-call signatures even without a baseline', (t) => {
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

test('InputSurgeGuard compares growth baselines only within the same input kind', (t) => {
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

test('InputSurgeGuard blocks a large tool result appended after a successful full-history request', (t) => {
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

  t.is(decision.action, 'block');
  t.true(decision.reason?.includes('tool result'));
});

test('InputSurgeGuard does not update baseline for blocked input', (t) => {
  const guard = new InputSurgeGuard();
  guard.recordSuccessfulInput(Array.from({ length: 65 }, (_, index) => ({ role: 'user', content: `m${index}` })));

  const blocked = Array.from({ length: 863 }, (_, index) => ({ role: 'user', content: `m${index}` }));
  t.is(guard.inspect(blocked).action, 'block');

  const stillComparedToOriginal = guard.inspect(
    Array.from({ length: 200 }, (_, index) => ({ role: 'user', content: `m${index}` })),
  );
  t.is(stillComparedToOriginal.action, 'block');
  t.is(stillComparedToOriginal.previousStats?.messageCount, 65);
});

test('InputSurgeGuard pending block fires once then clears', (t) => {
  const guard = new InputSurgeGuard();
  const requestHistory = [{ role: 'user', type: 'message', content: 'first query' }];
  const postRunHistory = [
    ...requestHistory,
    { type: 'function_call', callId: 'call-large' },
    { type: 'function_call_result', callId: 'call-large', output: 'x'.repeat(150_000) },
  ];

  // Record the successful input with a large appended tool result — this sets a pending block.
  guard.recordSuccessfulInput(postRunHistory, { kind: 'full_history', previousInput: requestHistory });

  // First inspect after the large tool result: pending block fires.
  const firstDecision = guard.inspect([...postRunHistory, { role: 'user', content: 'follow up' }], {
    kind: 'full_history',
  });
  t.is(firstDecision.action, 'block');
  t.true(firstDecision.reason?.includes('tool result'));

  // Second inspect with same kind: pending block is gone, so only a real surge would block.
  const secondDecision = guard.inspect([...postRunHistory, { role: 'user', content: 'another follow up' }], {
    kind: 'full_history',
  });
  // The history is now ~4 messages, well within normal growth — so it should be allowed.
  t.is(secondDecision.action, 'allow');
});
