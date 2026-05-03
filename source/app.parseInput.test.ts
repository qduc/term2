import test from 'ava';
import { parseInput, ParsedInput } from './utils/input-parser.js';

test('parseInput - regular messages', (t) => {
  const cases: Array<{ input: string; expected: ParsedInput }> = [
    {
      input: 'hello world',
      expected: { type: 'message', text: 'hello world' },
    },
    { input: 'test', expected: { type: 'message', text: 'test' } },
    {
      input: 'this is a longer message',
      expected: { type: 'message', text: 'this is a longer message' },
    },
  ];

  for (const { input, expected } of cases) {
    t.deepEqual(parseInput(input), expected, `Failed for input: "${input}"`);
  }
});

test('parseInput - slash commands without args', (t) => {
  const cases: Array<{ input: string; expected: ParsedInput }> = [
    {
      input: '/clear',
      expected: { type: 'slash-command', commandName: 'clear', args: '' },
    },
    {
      input: '/quit',
      expected: { type: 'slash-command', commandName: 'quit', args: '' },
    },
    {
      input: '/',
      expected: { type: 'slash-command', commandName: '', args: '' },
    },
  ];

  for (const { input, expected } of cases) {
    t.deepEqual(parseInput(input), expected, `Failed for input: "${input}"`);
  }
});

test('parseInput - slash commands with args', (t) => {
  const cases: Array<{ input: string; expected: ParsedInput }> = [
    {
      input: '/model gpt-4',
      expected: {
        type: 'slash-command',
        commandName: 'model',
        args: 'gpt-4',
      },
    },
    {
      input: '/settings agent.model gpt-4o',
      expected: {
        type: 'slash-command',
        commandName: 'settings',
        args: 'agent.model gpt-4o',
      },
    },
    {
      input: '/settings agent.reasoningEffort high',
      expected: {
        type: 'slash-command',
        commandName: 'settings',
        args: 'agent.reasoningEffort high',
      },
    },
  ];

  for (const { input, expected } of cases) {
    t.deepEqual(parseInput(input), expected, `Failed for input: "${input}"`);
  }
});

test('parseInput - edge cases', (t) => {
  // Multiple spaces are collapsed by split (which is fine)
  t.deepEqual(parseInput('/model   gpt-4'), {
    type: 'slash-command',
    commandName: 'model',
    args: 'gpt-4',
  });

  // Empty args when command has trailing spaces
  t.deepEqual(parseInput('/clear   '), {
    type: 'slash-command',
    commandName: 'clear',
    args: '',
  });

  // Command with special characters in args
  t.deepEqual(parseInput('/settings agent.model gpt-4.5-turbo'), {
    type: 'slash-command',
    commandName: 'settings',
    args: 'agent.model gpt-4.5-turbo',
  });
});
