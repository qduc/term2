import test from 'ava';
import {createAskMentorToolDefinition} from './ask-mentor.js';

// Mock function helper
const fn = (impl?: (...args: any[]) => any) => {
    const mock = (impl ? (...args: any[]) => impl(...args) : () => {}) as any;
    mock.calls = [];
    mock.impl = impl;
    return new Proxy(mock, {
        apply: (target, _thisArg, args) => {
            target.calls.push(args);
            return target(...args);
        }
    });
};

test('createAskMentorToolDefinition defines the tool correctly', t => {
    const mockAskMentor = fn();
    const tool = createAskMentorToolDefinition(mockAskMentor);

    t.is(tool.name, 'ask_mentor');
    t.true(tool.description.includes('mentor'));
    t.is(tool.needsApproval({question: 'test'}, undefined), false);
});

test('createAskMentorToolDefinition executes correctly', async t => {
    const mockAskMentor = fn(async () => 'Expert advice');
    const tool = createAskMentorToolDefinition(mockAskMentor);

    const result = await tool.execute({question: 'How do I center a div?'}, undefined);

    t.is(mockAskMentor.calls[0][0], 'How do I center a div?');
    t.is(result, 'Expert advice');
});

test('createAskMentorToolDefinition includes context', async t => {
    const mockAskMentor = fn(async () => 'Contextual advice');
    const tool = createAskMentorToolDefinition(mockAskMentor);

    const result = await tool.execute({
        question: 'Why is this failing?',
        context: 'Error: invalid prop',
    }, undefined);

    t.is(
        mockAskMentor.calls[0][0],
        'Context:\nError: invalid prop\n\nQuestion:\nWhy is this failing?'
    );
    t.is(result, 'Contextual advice');
});

test('createAskMentorToolDefinition handles errors', async t => {
    const mockAskMentor = fn(async () => { throw new Error('API Error'); });
    const tool = createAskMentorToolDefinition(mockAskMentor);

    const result = await tool.execute({question: 'fail'}, undefined);

    t.true((result as string).includes('Failed to ask mentor: API Error'));
});
