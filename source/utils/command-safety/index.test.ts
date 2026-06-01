import test from 'ava';
import { classifyCommandDetailed, validateCommandSafety } from './index.js';
import { SafetyStatus } from './constants.js';

test('classifyCommandDetailed returns merged execution metadata for sandbox-required commands', (t) => {
  const result = classifyCommandDetailed('node -e "console.log(1)"');

  t.is(result.status, SafetyStatus.YELLOW);
  t.true(result.reasons.length > 0);
  t.deepEqual(result.execution, {
    requiresSandbox: true,
    sandboxReason: 'node inline evaluation requires sandbox',
  });
});

test('classifyCommandDetailed keeps execution metadata empty for normal commands', (t) => {
  const result = classifyCommandDetailed('ls');

  t.is(result.status, SafetyStatus.GREEN);
  t.deepEqual(result.execution, {});
});

test('validateCommandSafety remains backward compatible', (t) => {
  t.false(validateCommandSafety('ls'));
  t.true(validateCommandSafety('node -e "console.log(1)"'));
});
