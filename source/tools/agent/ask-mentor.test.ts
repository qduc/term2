import { it, expect } from 'vitest';
import { createAskMentorToolDefinition } from './ask-mentor.js';

// Mock function helper
const fn = (impl?: (...args: any[]) => any) => {
  const mock = (impl ? (...args: any[]) => impl(...args) : () => {}) as any;
  mock.calls = [];
  mock.impl = impl;
  return new Proxy(mock, {
    apply: (target, _thisArg, args) => {
      target.calls.push(args);
      return target(...args);
    },
  });
};

it('createAskMentorToolDefinition defines the tool correctly', () => {
  const mockAskMentor = fn();
  const tool = createAskMentorToolDefinition(mockAskMentor);

  expect(tool.name).toBe('ask_mentor');
  expect(tool.description.includes('mentor')).toBe(true);
  expect(tool.needsApproval({ question: 'test' }, undefined)).toBe(false);
});

it('createAskMentorToolDefinition schema allows omitted context and rejects null', () => {
  const mockAskMentor = fn();
  const tool = createAskMentorToolDefinition(mockAskMentor);

  expect(tool.parameters.safeParse({ question: 'test' }).success).toBe(true);
  expect(tool.parameters.safeParse({ question: 'test', context: null }).success).toBe(false);
});

it('createAskMentorToolDefinition executes correctly', async () => {
  const mockAskMentor = fn(async () => 'Expert advice');
  const tool = createAskMentorToolDefinition(mockAskMentor);

  const result = await tool.execute({ question: 'How do I center a div?' }, undefined);

  expect(mockAskMentor.calls[0][0]).toBe('How do I center a div?');
  expect(result).toBe('Expert advice');
});

it('createAskMentorToolDefinition includes context', async () => {
  const mockAskMentor = fn(async () => 'Contextual advice');
  const tool = createAskMentorToolDefinition(mockAskMentor);

  const result = await tool.execute(
    {
      question: 'Why is this failing?',
      context: 'Error: invalid prop',
    },
    undefined,
  );

  expect(mockAskMentor.calls[0][0]).toBe('Context:\nError: invalid prop\n\nQuestion:\nWhy is this failing?');
  expect(result).toBe('Contextual advice');
});

it('createAskMentorToolDefinition handles errors', async () => {
  const mockAskMentor = fn(async () => {
    throw new Error('API Error');
  });
  const tool = createAskMentorToolDefinition(mockAskMentor);

  const result = await tool.execute({ question: 'fail' }, undefined);

  expect((result as string).includes('Failed to ask mentor: API Error')).toBe(true);
});
