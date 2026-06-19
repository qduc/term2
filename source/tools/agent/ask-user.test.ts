import { it, expect } from 'vitest';
import { createAskUserToolDefinition, formatAskUserCommandMessage } from './ask-user.js';
import {
  ASK_USER_CUSTOM_ANSWER_LABEL,
  ASK_USER_DECLINE_LABEL,
  ASK_USER_NO_ANSWER_RESULT,
  ASK_USER_NO_RESPONSE_DISPLAY,
} from './ask-user-constants.js';

const fn = (impl?: (...args: any[]) => any) => {
  const mock = (impl ? (...args: any[]) => impl(...args) : () => undefined) as any;
  mock.calls = [];
  mock.impl = impl;
  return new Proxy(mock, {
    apply: (target, _thisArg, args) => {
      target.calls.push(args);
      return target(...args);
    },
  });
};

it('createAskUserToolDefinition defines the tool correctly', () => {
  const mockGetAskUserAnswer = fn();
  const tool = createAskUserToolDefinition(mockGetAskUserAnswer);

  expect(tool.name).toBe('ask_user');
  expect(tool.description.includes('clarifying questions')).toBe(true);
  expect(tool.needsApproval({ questions: [{ question: 'test' }] }, undefined)).toBe(true);
});

it('createAskUserToolDefinition schema validates question and options', () => {
  const mockGetAskUserAnswer = fn();
  const tool = createAskUserToolDefinition(mockGetAskUserAnswer);

  expect(tool.parameters.safeParse({ questions: [{ question: 'What should I do?' }] }).success).toBe(true);
  expect(
    tool.parameters.safeParse({
      questions: [
        {
          question: 'Pick one',
          options: [
            { label: 'Use the safe default', description: 'Best chance of success' },
            { label: 'Ask later', description: 'Defer the decision' },
          ],
        },
      ],
    }).success,
  ).toBe(true);
  expect(tool.parameters.safeParse({ questions: [{ question: '' }] }).success).toBe(false);
  expect(tool.parameters.safeParse({ questions: [{ question: '   ' }] }).success).toBe(false);
  expect(
    tool.parameters.safeParse({
      questions: [{ question: 'Pick one', options: [{ label: '   ', description: 'Invalid' }] }],
    }).success,
  ).toBe(false);
  expect(
    tool.parameters.safeParse({
      questions: [{ question: 'Pick one', options: [{ label: ASK_USER_CUSTOM_ANSWER_LABEL }] }],
    }).success,
  ).toBe(false);
  expect(
    tool.parameters.safeParse({
      questions: [{ question: 'Pick one', options: [{ label: ASK_USER_DECLINE_LABEL }] }],
    }).success,
  ).toBe(false);
  expect(
    tool.parameters.safeParse({
      questions: [
        {
          question: 'Pick one',
          options: [
            { label: '1' },
            { label: '2' },
            { label: '3' },
            { label: '4' },
            { label: '5' },
            { label: '6' },
            { label: '7' },
            { label: '8' },
            { label: '9' },
          ],
        },
      ],
    }).success,
  ).toBe(false);
  // Options must have at least 2 options
  expect(
    tool.parameters.safeParse({
      questions: [
        {
          question: 'Pick one',
          options: [{ label: 'Just one' }],
        },
      ],
    }).success,
  ).toBe(false);
  // is_multi_select requires options
  expect(
    tool.parameters.safeParse({
      questions: [
        {
          question: 'Pick many',
          is_multi_select: true,
        },
      ],
    }).success,
  ).toBe(false);
  // is_multi_select with options is valid
  expect(
    tool.parameters.safeParse({
      questions: [
        {
          question: 'Pick many',
          options: [{ label: 'A' }, { label: 'B' }],
          is_multi_select: true,
        },
      ],
    }).success,
  ).toBe(true);
});

it('createAskUserToolDefinition executes and returns the answer', async () => {
  const mockGetAskUserAnswer = fn(() => '["Use the existing config"]');
  const tool = createAskUserToolDefinition(mockGetAskUserAnswer);

  const result = await tool.execute({ questions: [{ question: 'Which config should I use?' }] }, undefined, {
    toolCall: { callId: 'call-1' },
  });

  expect(mockGetAskUserAnswer.calls[0][0]).toBe('call-1');
  expect(result).toBe('["Use the existing config"]');
});

it('createAskUserToolDefinition returns fallback text when no answer is provided', async () => {
  const mockGetAskUserAnswer = fn(() => undefined);
  const tool = createAskUserToolDefinition(mockGetAskUserAnswer);

  const result = await tool.execute({ questions: [{ question: 'Which config should I use?' }] }, undefined, {
    toolCall: { callId: 'call-2' },
  });

  expect(mockGetAskUserAnswer.calls[0][0]).toBe('call-2');
  expect(result).toBe(ASK_USER_NO_ANSWER_RESULT);
});

it('createAskUserToolDefinition returns fallback text when no answer is provided even with options', async () => {
  const mockGetAskUserAnswer = fn(() => undefined);
  const tool = createAskUserToolDefinition(mockGetAskUserAnswer);

  const result = await tool.execute(
    {
      questions: [{ question: 'Choose one', options: [{ label: 'Use safe default' }, { label: 'Ask later' }] }],
    },
    undefined,
    {
      toolCall: { callId: 'call-3' },
    },
  );

  expect(result).toBe(ASK_USER_NO_ANSWER_RESULT);
});

it('formatAskUserCommandMessage renders the question and output', () => {
  const item = {
    rawItem: {
      callId: 'call-1',
      arguments: JSON.stringify({ questions: [{ question: 'Which config should I use?' }] }),
      output: '["Use the existing config"]',
    },
  };

  const messages = formatAskUserCommandMessage(item, 0, new Map());

  expect(messages.length).toBe(1);
  expect(messages[0].command).toBe('ask_user: Which config should I use?');
  expect(messages[0].output).toBe('Question: Which config should I use?\nAnswer: Use the existing config');
  expect(messages[0].success).toBe(true);
  expect(messages[0].toolName).toBe('ask_user');
});

it('formatAskUserCommandMessage handles fallback arguments', () => {
  const item = {
    rawItem: {
      callId: 'call-2',
      output: 'User did not provide an answer.',
    },
  };
  const toolCallArgumentsById = new Map([
    [
      'call-2',
      JSON.stringify({
        questions: [
          {
            question: 'Pick a safe default',
            options: [
              { label: 'Use safe default', description: 'Preferred path' },
              { label: 'Ask later', description: 'Need more context' },
            ],
          },
        ],
      }),
    ],
  ]);

  const messages = formatAskUserCommandMessage(item, 0, toolCallArgumentsById);

  expect(messages[0].command).toBe('ask_user: Pick a safe default');
  expect(messages[0].output).toBe('User did not provide an answer.');
  expect(messages[0].success).toBe(false);
  expect(messages[0].toolArgs).toEqual({
    questions: [
      {
        question: 'Pick a safe default',
        options: [
          { label: 'Use safe default', description: 'Preferred path' },
          { label: 'Ask later', description: 'Need more context' },
        ],
      },
    ],
  });
});

it('formatAskUserCommandMessage treats missing output as unsuccessful', () => {
  const item = {
    rawItem: {
      callId: 'call-3',
      arguments: JSON.stringify({ questions: [{ question: 'Which config should I use?' }] }),
    },
  };

  const messages = formatAskUserCommandMessage(item, 0, new Map());

  expect(messages[0].output).toBe(ASK_USER_NO_RESPONSE_DISPLAY);
  expect(messages[0].success).toBe(false);
});

it('formatAskUserCommandMessage falls back for malformed arguments', () => {
  const item = {
    rawItem: {
      callId: 'call-4',
      arguments: JSON.stringify({ questions: [{ question: '   ' }] }),
      output: '["Use default"]',
    },
  };

  const messages = formatAskUserCommandMessage(item, 0, new Map());

  expect(messages[0].command).toBe('ask_user: Unknown questions');
  expect(messages[0].output).toBe('["Use default"]');
  expect(messages[0].success).toBe(true);
});

it('formatAskUserCommandMessage formats array answers with mismatched length', () => {
  const item = {
    rawItem: {
      callId: 'call-5',
      arguments: JSON.stringify({ questions: [{ question: 'Choose one' }] }),
      output: '["a", "b"]',
    },
  };

  const messages = formatAskUserCommandMessage(item, 0, new Map());

  expect(messages[0].command).toBe('ask_user: Choose one');
  // Output should fall back to a joined representation since 2 answers != 1 question
  expect(messages[0].output.includes('a')).toBe(true);
  expect(messages[0].output.includes('b')).toBe(true);
  expect(messages[0].success).toBe(true);
});

it('createAskUserToolDefinition allows options with labels and descriptions', () => {
  const mockGetAskUserAnswer = fn();
  const tool = createAskUserToolDefinition(mockGetAskUserAnswer);

  expect(
    tool.parameters.safeParse({
      questions: [
        {
          question: 'Pick one',
          options: [
            { label: 'OAuth', description: 'Google/GitHub login' },
            { label: 'JWT', description: 'Token-based authentication' },
          ],
        },
      ],
    }).success,
  ).toBe(true);
});
