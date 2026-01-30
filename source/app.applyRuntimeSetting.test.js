import test from 'ava';

// Test the logic for parsing model selection with provider information
// This simulates what happens when a user selects a model from the ModelSelectionMenu

test('applyRuntimeSetting - parses model without provider', t => {
    const value = 'gpt-4o';
    const providerMatch = String(value).match(/--provider=([\w.-]+)/);
    const modelId = String(value)
        .replace(/\s*--provider=[\w.-]+\s*/, '')
        .trim();

    t.is(providerMatch, null);
    t.is(modelId, 'gpt-4o');
});

test('applyRuntimeSetting - parses model with openai provider', t => {
    const value = 'gpt-4o --provider=openai';
    const providerMatch = String(value).match(/--provider=([\w.-]+)/);
    const modelId = String(value)
        .replace(/\s*--provider=[\w.-]+\s*/, '')
        .trim();

    t.truthy(providerMatch);
    t.is(providerMatch[1], 'openai');
    t.is(modelId, 'gpt-4o');
});

test('applyRuntimeSetting - parses model with openrouter provider', t => {
    const value = 'anthropic/claude-3.5-sonnet --provider=openrouter';
    const providerMatch = String(value).match(/--provider=([\w.-]+)/);
    const modelId = String(value)
        .replace(/\s*--provider=[\w.-]+\s*/, '')
        .trim();

    t.truthy(providerMatch);
    t.is(providerMatch[1], 'openrouter');
    t.is(modelId, 'anthropic/claude-3.5-sonnet');
});

test('applyRuntimeSetting - handles model with provider and extra whitespace', t => {
    const value = 'gpt-4o    --provider=openai   ';
    const providerMatch = String(value).match(/--provider=([\w.-]+)/);
    const modelId = String(value)
        .replace(/\s*--provider=[\w.-]+\s*/, '')
        .trim();

    t.truthy(providerMatch);
    t.is(providerMatch[1], 'openai');
    t.is(modelId, 'gpt-4o');
});

test('insertSelectedModel - formats model ID with provider from current state', t => {
    // Simulate what insertSelectedModel does - uses current provider state, not selection.provider
    const selection = {
        id: 'anthropic/claude-3.5-sonnet',
        provider: 'openai', // This could be stale
    };
    const currentProvider = 'openrouter'; // This is the current provider state

    const before = '/model ';
    const nextValue = `${before}${selection.id} --provider=${currentProvider}`;

    t.is(nextValue, '/model anthropic/claude-3.5-sonnet --provider=openrouter');
});

test('insertSelectedModel - formats OpenAI model with provider from current state', t => {
    // Simulate what insertSelectedModel does for OpenAI model
    const selection = {
        id: 'gpt-4o',
        provider: 'openrouter', // This could be stale
    };
    const currentProvider = 'openai'; // This is the current provider state

    const before = '/model ';
    const nextValue = `${before}${selection.id} --provider=${currentProvider}`;

    t.is(nextValue, '/model gpt-4o --provider=openai');
});
