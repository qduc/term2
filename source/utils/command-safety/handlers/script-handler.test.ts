import test from 'ava';
import { SafetyStatus } from '../constants.js';
import { classifyCommandDetailed } from '../index.js';

test('script handler classifies inline interpreter eval commands as sandbox-required', (t) => {
  const cases = [
    'node -e "console.log(1)"',
    'node --eval "console.log(1)"',
    'node -p "1 + 1"',
    'python -c "print(1)"',
    'python3 -c "print(1)"',
    'bash -c "echo hello"',
    'sh -c "echo hello"',
    'zsh -c "echo hello"',
    'dash -c "echo hello"',
  ];

  for (const command of cases) {
    const result = classifyCommandDetailed(command);
    t.is(result.status, SafetyStatus.YELLOW, command);
    t.true(result.execution.requiresSandbox, command);
    t.truthy(result.execution.sandboxReason, command);
  }
});

test('script handler classifies direct script targets as sandbox-required', (t) => {
  const cases = ['node temp.js', 'python test.py', './run.sh', 'scripts/build.sh', 'node_modules/.bin/eslint'];

  for (const command of cases) {
    const result = classifyCommandDetailed(command);
    t.is(result.status, SafetyStatus.YELLOW, command);
    t.true(result.execution.requiresSandbox, command);
  }
});

test('script handler leaves interpreter metadata commands as green', (t) => {
  const cases = ['node --version', 'python --version', 'bash --version', 'sh --help'];

  for (const command of cases) {
    const result = classifyCommandDetailed(command);
    t.is(result.status, SafetyStatus.GREEN, command);
    t.false(result.execution.requiresSandbox ?? false, command);
  }
});

test('script handler propagates sandbox requirement through nested command substitutions', (t) => {
  const result = classifyCommandDetailed('echo $(node -e "console.log(1)")');

  t.is(result.status, SafetyStatus.YELLOW);
  t.true(result.execution.requiresSandbox);
});
