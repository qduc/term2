import test from 'ava';
import { collectInputSurgeStats, InputSurgeGuard } from './input-surge-guard.js';

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
