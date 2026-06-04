import test from 'ava';
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

test('createAskUserToolDefinition defines the tool correctly', (t) => {
  const mockGetAskUserAnswer = fn();
  const tool = createAskUserToolDefinition(mockGetAskUserAnswer);

  t.is(tool.name, 'ask_user');
  t.true(tool.description.includes('clarifying question'));
  t.true(tool.needsApproval({ question: 'test' }, undefined));
});

test('createAskUserToolDefinition schema validates question and options', (t) => {
  const mockGetAskUserAnswer = fn();
  const tool = createAskUserToolDefinition(mockGetAskUserAnswer);

  t.true(tool.parameters.safeParse({ question: 'What should I do?' }).success);
  t.true(
    tool.parameters.safeParse({
      question: 'Pick one',
      options: ['Use the safe default', 'Ask later'],
    }).success,
  );
  t.false(tool.parameters.safeParse({ question: '' }).success);
  t.false(tool.parameters.safeParse({ question: '   ' }).success);
  t.false(tool.parameters.safeParse({ question: 'Pick one', options: ['   '] }).success);
  t.false(tool.parameters.safeParse({ question: 'Pick one', options: [ASK_USER_CUSTOM_ANSWER_LABEL] }).success);
  t.false(tool.parameters.safeParse({ question: 'Pick one', options: [ASK_USER_DECLINE_LABEL] }).success);
  t.false(
    tool.parameters.safeParse({
      question: 'Pick one',
      options: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
    }).success,
  );
});

test('createAskUserToolDefinition executes and returns the answer', async (t) => {
  const mockGetAskUserAnswer = fn(() => 'Use the existing config');
  const tool = createAskUserToolDefinition(mockGetAskUserAnswer);

  const result = await tool.execute({ question: 'Which config should I use?' }, undefined, {
    toolCall: { callId: 'call-1' },
  });

  t.is(mockGetAskUserAnswer.calls[0][0], 'call-1');
  t.is(result, 'Use the existing config');
});

test('createAskUserToolDefinition returns fallback text when no answer is provided', async (t) => {
  const mockGetAskUserAnswer = fn(() => undefined);
  const tool = createAskUserToolDefinition(mockGetAskUserAnswer);

  const result = await tool.execute({ question: 'Which config should I use?' }, undefined, {
    toolCall: { callId: 'call-2' },
  });

  t.is(mockGetAskUserAnswer.calls[0][0], 'call-2');
  t.is(result, ASK_USER_NO_ANSWER_RESULT);
});

test('createAskUserToolDefinition returns fallback text when no answer is provided even with options', async (t) => {
  const mockGetAskUserAnswer = fn(() => undefined);
  const tool = createAskUserToolDefinition(mockGetAskUserAnswer);

  const result = await tool.execute({ question: 'Choose one', options: ['Use safe default', 'Ask later'] }, undefined, {
    toolCall: { callId: 'call-3' },
  });

  t.is(result, ASK_USER_NO_ANSWER_RESULT);
});

test('formatAskUserCommandMessage renders the question and output', (t) => {
  const item = {
    rawItem: {
      callId: 'call-1',
      arguments: JSON.stringify({ question: 'Which config should I use?' }),
      output: 'Use the existing config',
    },
  };

  const messages = formatAskUserCommandMessage(item, 0, new Map());

  t.is(messages.length, 1);
  t.is(messages[0].command, 'ask_user: Which config should I use?');
  t.is(messages[0].output, 'Use the existing config');
  t.true(messages[0].success);
  t.is(messages[0].toolName, 'ask_user');
});

test('formatAskUserCommandMessage handles fallback arguments', (t) => {
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
        question: 'Pick a safe default',
        options: ['Use safe default', 'Ask later'],
      }),
    ],
  ]);

  const messages = formatAskUserCommandMessage(item, 0, toolCallArgumentsById);

  t.is(messages[0].command, 'ask_user: Pick a safe default');
  t.is(messages[0].output, 'User did not provide an answer.');
  t.false(messages[0].success);
  t.deepEqual(messages[0].toolArgs, {
    question: 'Pick a safe default',
    options: ['Use safe default', 'Ask later'],
  });
});

test('formatAskUserCommandMessage treats missing output as unsuccessful', (t) => {
  const item = {
    rawItem: {
      callId: 'call-3',
      arguments: JSON.stringify({ question: 'Which config should I use?' }),
    },
  };

  const messages = formatAskUserCommandMessage(item, 0, new Map());

  t.is(messages[0].output, ASK_USER_NO_RESPONSE_DISPLAY);
  t.false(messages[0].success);
});

test('formatAskUserCommandMessage falls back for malformed arguments', (t) => {
  const item = {
    rawItem: {
      callId: 'call-4',
      arguments: JSON.stringify({ question: '   ' }),
      output: 'Use default',
    },
  };

  const messages = formatAskUserCommandMessage(item, 0, new Map());

  t.is(messages[0].command, 'ask_user: Unknown question');
  t.true(messages[0].success);
});
