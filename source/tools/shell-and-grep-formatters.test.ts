import { it, expect } from 'vitest';
import { formatShellCommandMessage } from './system/shell.js';
import { formatGrepCommandMessage } from './system/grep.js';

it('formatShellCommandMessage: sets toolName to "shell"', () => {
  const item = {
    arguments: { command: 'echo "hello"' },
    output: 'exit 0\nhello',
  };
  const messages = formatShellCommandMessage(item, 0, new Map());
  expect(messages.length).toBe(1);
  expect(messages[0].toolName).toBe('shell');
  expect(messages[0].command).toBe('echo "hello"');
});

it('formatGrepCommandMessage: sets toolName to "grep" and populates toolArgs', () => {
  const item = {
    arguments: { pattern: 'TODO', path: 'src/' },
    output: 'src/main.ts:1:TODO: something',
  };
  const messages = formatGrepCommandMessage(item, 0, new Map());
  expect(messages.length).toBe(1);
  expect(messages[0].toolName).toBe('grep');
  expect(messages[0].command).toBe('grep "TODO" "src/"');
  expect(messages[0].toolArgs).toEqual({ pattern: 'TODO', path: 'src/' });
});
