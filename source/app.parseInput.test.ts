import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { parseInput, ParsedInput } from './utils/input-parser.js';

it('parseInput - regular messages', () => {
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
    expect(parseInput(input), `Failed for input: "${input}"`).toEqual(expected);
  }
});

it('parseInput - slash commands without args', () => {
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
    expect(parseInput(input), `Failed for input: "${input}"`).toEqual(expected);
  }
});

it('parseInput - slash commands with args', () => {
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
    expect(parseInput(input), `Failed for input: "${input}"`).toEqual(expected);
  }
});

it('parseInput - edge cases', () => {
  // Multiple spaces are collapsed by split (which is fine)
  expect(parseInput('/model   gpt-4')).toEqual({
    type: 'slash-command',
    commandName: 'model',
    args: 'gpt-4',
  });

  // Empty args when command has trailing spaces
  expect(parseInput('/clear   ')).toEqual({
    type: 'slash-command',
    commandName: 'clear',
    args: '',
  });

  // Command with special characters in args
  expect(parseInput('/settings agent.model gpt-4.5-turbo')).toEqual({
    type: 'slash-command',
    commandName: 'settings',
    args: 'agent.model gpt-4.5-turbo',
  });
});
