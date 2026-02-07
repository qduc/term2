import test from 'ava';
import {normalizeUsage, extractUsage, formatFooterUsage} from './token-usage.js';

test('normalizeUsage handles multiple formats', t => {
    // OpenAI style
    t.deepEqual(normalizeUsage({prompt_tokens: 10, completion_tokens: 20, total_tokens: 30}), {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30
    });

    // Agents SDK style
    t.deepEqual(normalizeUsage({inputTokens: 5, outputTokens: 15, totalTokens: 20}), {
        prompt_tokens: 5,
        completion_tokens: 15,
        total_tokens: 20
    });

    // Mixed/partial
    t.deepEqual(normalizeUsage({input_tokens: 100}), {
        prompt_tokens: 100,
        total_tokens: 100
    });
});

test('extractUsage finds usage in nested locations', t => {
    const payload = {
        usage: { prompt_tokens: 1, total_tokens: 3 },
        response: { usage: { completion_tokens: 2, total_tokens: 3 } }
    };
    t.deepEqual(extractUsage(payload), {
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3
    });
});

test('formatFooterUsage returns formatted string', t => {
    t.is(formatFooterUsage({prompt_tokens: 1200, completion_tokens: 350, total_tokens: 1550}), 'Tok: 1,200 in / 350 out / 1,550 total');
    t.is(formatFooterUsage({total_tokens: 100}), 'Tok: 100 total');
    t.is(formatFooterUsage(null), '');
});
