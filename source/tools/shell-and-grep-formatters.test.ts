import test from 'ava';
import { formatShellCommandMessage } from './shell.js';
import { formatGrepCommandMessage } from './grep.js';

test('formatShellCommandMessage: sets toolName to "shell"', (t) => {
  const item = {
    arguments: { command: 'echo "hello"' },
    output: 'exit 0\nhello',
  };
  const messages = formatShellCommandMessage(item, 0, new Map());
  t.is(messages.length, 1);
  t.is(messages[0].toolName, 'shell');
  t.is(messages[0].command, 'echo "hello"');
});

test('formatGrepCommandMessage: sets toolName to "grep"', (t) => {
  const item = {
    arguments: { pattern: 'TODO', path: 'src/' },
    output: 'src/main.ts:1:TODO: something',
  };
  const messages = formatGrepCommandMessage(item, 0, new Map());
  t.is(messages.length, 1);
  t.is(messages[0].toolName, 'grep');
  t.is(messages[0].command, 'grep "TODO" "src/"');
});
