import test from 'ava';
import { extractCopilotTextDelta } from './model.js';

test('extractCopilotTextDelta returns full chunk when no accumulation', t => {
    t.is(extractCopilotTextDelta('', 'Hello'), 'Hello');
});

test('extractCopilotTextDelta returns only new suffix when chunk repeats accumulation', t => {
    t.is(extractCopilotTextDelta('Hello', 'Hello world'), ' world');
});

test('extractCopilotTextDelta returns empty string when chunk equals accumulation', t => {
    t.is(extractCopilotTextDelta('Hello', 'Hello'), '');
});

test('extractCopilotTextDelta returns chunk when it is not a prefix match', t => {
    t.is(extractCopilotTextDelta('Hello', 'Hi there'), 'Hi there');
});