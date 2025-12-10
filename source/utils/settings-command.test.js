import test from 'ava';
import {
    createSettingsCommand,
    formatSettingsSummary,
    parseSettingValue,
} from '../../dist/utils/settings-command.js';

const baseSettings = {
    agent: {
        model: {value: 'gpt-5.1', source: 'default'},
        reasoningEffort: {value: 'default', source: 'default'},
        provider: {value: 'openai', source: 'default'},
        maxTurns: {value: 20, source: 'default'},
        retryAttempts: {value: 2, source: 'default'},
    },
    shell: {
        timeout: {value: 120000, source: 'default'},
        maxOutputLines: {value: 1000, source: 'default'},
        maxOutputChars: {value: 10000, source: 'default'},
    },
    ui: {
        historySize: {value: 1000, source: 'default'},
    },
    logging: {
        logLevel: {value: 'info', source: 'default'},
    },
};

const createDeps = (overrides = {}) => {
    const messages = [];
    const setCalls = [];
    const resetCalls = [];
    const applied = [];

    const settingsService = {
        getAll: () => baseSettings,
        get: key => overrides.values?.[key] ?? 'value-for-' + key,
        getSource: key => overrides.sources?.[key] ?? 'default',
        reset: key => resetCalls.push(key),
        isRuntimeModifiable: overrides.isRuntimeModifiable || (() => true),
        set: (key, value) => setCalls.push({key, value}),
        ...overrides.settingsService,
    };

    return {
        messages,
        setCalls,
        resetCalls,
        applied,
        settingsService,
        addSystemMessage: message => messages.push(message),
        applyRuntimeSetting: (key, value) => applied.push({key, value}),
        setInput: () => {},
    };
};

test('formatSettingsSummary renders values with sources', t => {
    const summary = formatSettingsSummary(baseSettings);

    t.true(summary.includes('agent.model: gpt-5.1 (default)'));
    t.true(summary.includes('shell.timeout: 120000 (default)'));
    t.true(summary.includes('logging.logLevel: info (default)'));
});

test('viewing all settings with no args prompts for autocomplete', t => {
    const deps = createDeps();
    let inputValue = '';
    deps.setInput = (value) => { inputValue = value; };
    const command = createSettingsCommand(deps);
    const result = command.action();

    // Should set input to '/settings ' and return false to keep input active
    t.is(result, false);
    t.is(inputValue, '/settings ');
    t.is(deps.messages.length, 0); // No message sent
});

test('viewing a single setting shows value and source', t => {
    const deps = createDeps({
        values: {'agent.model': 'gpt-4o'},
        sources: {'agent.model': 'cli'},
    });
    const command = createSettingsCommand(deps);
    command.action('agent.model');

    t.is(deps.messages.length, 1);
    t.true(deps.messages[0].includes('agent.model: gpt-4o (cli)'));
});

test('setting runtime-modifiable values updates service and applies runtime hook', t => {
    const deps = createDeps();
    const command = createSettingsCommand(deps);
    command.action('agent.model gpt-4o');

    t.deepEqual(deps.setCalls, [{key: 'agent.model', value: 'gpt-4o'}]);
    t.deepEqual(deps.applied, [{key: 'agent.model', value: 'gpt-4o'}]);
    t.true(deps.messages[0].includes('Set agent.model to gpt-4o'));
});

test('refuses to set startup-only values at runtime', t => {
    const deps = createDeps({
        isRuntimeModifiable: key => key !== 'agent.maxTurns',
    });
    const command = createSettingsCommand(deps);
    command.action('agent.maxTurns 40');

    t.deepEqual(deps.setCalls, []);
    t.deepEqual(deps.applied, []);
    t.true(deps.messages[0].toLowerCase().includes('restart'));
});

test('reset restores defaults and reports action', t => {
    const deps = createDeps();
    const command = createSettingsCommand(deps);
    command.action('reset shell.timeout');

    t.deepEqual(deps.resetCalls, ['shell.timeout']);
    t.true(deps.messages[0].includes('Reset shell.timeout'));
});

test('parseSettingValue converts common primitives', t => {
    t.is(parseSettingValue('42'), 42);
    t.is(parseSettingValue('true'), true);
    t.is(parseSettingValue('false'), false);
    t.is(parseSettingValue('gpt-4o'), 'gpt-4o');
});

test('setting agent.model strips --provider flag from value', t => {
    const deps = createDeps();
    const command = createSettingsCommand(deps);
    command.action('agent.model mistralai/devstral-2512:free --provider=openrouter');

    // Should save the provider and the model ID
    t.deepEqual(deps.setCalls, [
        {key: 'agent.provider', value: 'openrouter'},
        {key: 'agent.model', value: 'mistralai/devstral-2512:free'}
    ]);
    t.deepEqual(deps.applied, [
        {key: 'agent.provider', value: 'openrouter'},
        {key: 'agent.model', value: 'mistralai/devstral-2512:free'}
    ]);
    t.true(deps.messages[0].includes('Set agent.model to mistralai/devstral-2512:free'));
});

test('setting agent.model strips --provider=openai flag from value', t => {
    const deps = createDeps();
    const command = createSettingsCommand(deps);
    command.action('agent.model gpt-4o --provider=openai');

    // Should save the provider and the model ID
    t.deepEqual(deps.setCalls, [
        {key: 'agent.provider', value: 'openai'},
        {key: 'agent.model', value: 'gpt-4o'}
    ]);
    t.deepEqual(deps.applied, [
        {key: 'agent.provider', value: 'openai'},
        {key: 'agent.model', value: 'gpt-4o'}
    ]);
    t.true(deps.messages[0].includes('Set agent.model to gpt-4o'));
});

test('setting agent.model without provider flag works normally', t => {
    const deps = createDeps();
    const command = createSettingsCommand(deps);
    command.action('agent.model gpt-5.1');

    // Should save the model ID as-is
    t.deepEqual(deps.setCalls, [{key: 'agent.model', value: 'gpt-5.1'}]);
    t.deepEqual(deps.applied, [{key: 'agent.model', value: 'gpt-5.1'}]);
    t.true(deps.messages[0].includes('Set agent.model to gpt-5.1'));
});
