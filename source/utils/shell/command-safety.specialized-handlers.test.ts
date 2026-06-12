import test from 'ava';
import { classifyCommand, SafetyStatus } from './command-safety/index.js';

test('specialized command handlers still inspect command substitutions', (t) => {
  const commands = [
    'git status $(rm -rf /)',
    'git show `rm -rf /`',
    'find . -name $(rm -rf /)',
    'sed -n $(rm -rf /) file.txt',
  ];

  for (const command of commands) {
    t.is(classifyCommand(command), SafetyStatus.RED, `"${command}" should inspect nested command substitution`);
  }
});

test('specialized command handlers still inspect assignment command substitutions', (t) => {
  const commands = ['TARGET=$(rm -rf /) git status', 'PATTERN=$(rm -rf /) find . -name "*.ts"'];

  for (const command of commands) {
    t.is(classifyCommand(command), SafetyStatus.RED, `"${command}" should inspect command substitutions in prefixes`);
  }
});
