import test from 'ava';
import { createSettingsCommand, formatSettingsSummary, parseSettingValue } from './settings-command.js';
import { unregisterProvider, upsertProvider } from '../providers/index.js';
import type { SettingsWithSources } from '../services/settings-schema.js';
import type { SettingsService } from '../services/settings-service.js';

const baseSettings = {
  agent: {
    model: { value: 'gpt-5.1', source: 'default' },
    reasoningEffort: { value: 'default', source: 'default' },
    temperature: { value: undefined, source: 'default' },
    mentorModel: { value: undefined, source: 'default' },
    mentorProvider: { value: undefined, source: 'default' },
    mentorReasoningEffort: { value: 'default', source: 'default' },
    useFlexServiceTier: { value: false, source: 'default' },
    provider: { value: 'openai', source: 'default' },
    maxTurns: { value: 20, source: 'default' },
    retryAttempts: { value: 2, source: 'default' },
    maxParallelToolCalls: { value: 3, source: 'default' },
  },
  shell: {
    timeout: { value: 120000, source: 'default' },
    maxOutputLines: { value: 1000, source: 'default' },
    maxOutputChars: { value: 10000, source: 'default' },
  },
  ui: {
    historySize: { value: 1000, source: 'default' },
  },
  logging: {
    logLevel: { value: 'info', source: 'default' },
  },
  app: {
    mentorMode: { value: false, source: 'default' },
    editMode: { value: false, source: 'default' },
  },
} as unknown as SettingsWithSources;

const createDeps = (
  overrides: {
    values?: Record<string, unknown>;
    sources?: Record<string, string>;
    isRuntimeModifiable?: (key: string) => boolean;
    settingsService?: Record<string, unknown>;
  } = {},
) => {
  const messages: string[] = [];
  const setCalls: Array<{ key: string; value: unknown }> = [];
  const resetCalls: string[] = [];
  const applied: Array<{ key: string; value: unknown }> = [];

  const settingsService = {
    getAll: () => baseSettings,
    get: <T = unknown>(key: string): T => (overrides.values?.[key] ?? 'value-for-' + key) as T,
    getSource: (key: string) => overrides.sources?.[key] ?? 'default',
    reset: (key: string) => resetCalls.push(key),
    isRuntimeModifiable: overrides.isRuntimeModifiable || (() => true),
    set: (key: string, value: unknown) => setCalls.push({ key, value }),
    ...overrides.settingsService,
  };

  return {
    messages,
    setCalls,
    resetCalls,
    applied,
    settingsService: settingsService as unknown as SettingsService,
    addSystemMessage: (message: string) => messages.push(message),
    applyRuntimeSetting: (key: string, value: unknown) => applied.push({ key, value }),
    setInput: (_value: string) => {},
  };
};

test('formatSettingsSummary renders values with sources', (t) => {
  const summary = formatSettingsSummary(baseSettings);

  t.true(summary.includes('agent.model: gpt-5.1 (default)'));
  t.true(summary.includes('shell.timeout: 120000 (default)'));
  t.true(summary.includes('logging.logLevel: info (default)'));
  t.true(summary.includes('agent.maxParallelToolCalls: 3 (default)'));
});

test('viewing all settings with no args prompts for autocomplete', (t) => {
  const deps = createDeps();
  let inputValue = '';
  deps.setInput = (value) => {
    inputValue = value;
  };
  const command = createSettingsCommand(deps);
  const result = command.action();

  // Should set input to '/settings ' and return false to keep input active
  t.is(result, false);
  t.is(inputValue, '/settings ');
  t.is(deps.messages.length, 0); // No message sent
});

test('viewing a single setting shows value and source', (t) => {
  const deps = createDeps({
    values: { 'agent.model': 'gpt-4o' },
    sources: { 'agent.model': 'cli' },
  });
  const command = createSettingsCommand(deps);
  command.action('agent.model');

  t.is(deps.messages.length, 1);
  t.true(deps.messages[0].includes('agent.model: gpt-4o (cli)'));
});

test('setting runtime-modifiable values updates service and applies runtime hook', (t) => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('agent.model gpt-4o');

  t.deepEqual(deps.setCalls, [{ key: 'agent.model', value: 'gpt-4o' }]);
  t.deepEqual(deps.applied, [{ key: 'agent.model', value: 'gpt-4o' }]);
  t.true(deps.messages[0].includes('Set agent.model to gpt-4o'));
});

test('setting agent.maxParallelToolCalls validates positive integers', (t) => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('agent.maxParallelToolCalls 0');

  t.deepEqual(deps.setCalls, []);
  t.deepEqual(deps.applied, []);
  t.true(deps.messages[0].includes('greater than or equal to 1'));
});

test('setting agent.maxParallelToolCalls reports that the new limit applies on the next request', (t) => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('agent.maxParallelToolCalls 5');

  t.deepEqual(deps.setCalls, [{ key: 'agent.maxParallelToolCalls', value: 5 }]);
  t.deepEqual(deps.applied, [{ key: 'agent.maxParallelToolCalls', value: 5 }]);
  t.true(deps.messages.some((msg) => msg.includes('takes effect on the next request')));
});

test('resetting agent.maxParallelToolCalls reports that the default applies on the next request', (t) => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('reset agent.maxParallelToolCalls');

  t.deepEqual(deps.resetCalls, ['agent.maxParallelToolCalls']);
  t.deepEqual(deps.applied, [{ key: 'agent.maxParallelToolCalls', value: 'value-for-agent.maxParallelToolCalls' }]);
  t.true(deps.messages.some((msg) => msg.includes('takes effect on the next request')));
});

test('refuses to set startup-only values at runtime', (t) => {
  const deps = createDeps({
    isRuntimeModifiable: (key) => key !== 'agent.maxTurns',
  });
  const command = createSettingsCommand(deps);
  command.action('agent.maxTurns 40');

  t.deepEqual(deps.setCalls, []);
  t.deepEqual(deps.applied, []);
  t.true(deps.messages[0].toLowerCase().includes('restart'));
});

test('reset restores defaults and reports action', (t) => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('reset shell.timeout');

  t.deepEqual(deps.resetCalls, ['shell.timeout']);
  t.true(deps.messages[0].includes('Reset shell.timeout'));
});

test('parseSettingValue converts common primitives', (t) => {
  t.is(parseSettingValue('42'), 42);
  t.is(parseSettingValue('true'), true);
  t.is(parseSettingValue('false'), false);
  t.is(parseSettingValue('gpt-4o'), 'gpt-4o');
});

test('setting agent.model strips --provider flag from value', (t) => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('agent.model mistralai/devstral-2512:free --provider=openrouter');

  // Should save the provider and the model ID
  t.deepEqual(deps.setCalls, [
    { key: 'agent.provider', value: 'openrouter' },
    { key: 'agent.model', value: 'mistralai/devstral-2512:free' },
  ]);
  t.deepEqual(deps.applied, [
    { key: 'agent.provider', value: 'openrouter' },
    { key: 'agent.model', value: 'mistralai/devstral-2512:free' },
  ]);
  t.true(deps.messages[0].includes('Set agent.model to mistralai/devstral-2512:free'));
});

test('setting agent.model strips --provider=openai flag from value', (t) => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('agent.model gpt-4o --provider=openai');

  // Should save the provider and the model ID
  t.deepEqual(deps.setCalls, [
    { key: 'agent.provider', value: 'openai' },
    { key: 'agent.model', value: 'gpt-4o' },
  ]);
  t.deepEqual(deps.applied, [
    { key: 'agent.provider', value: 'openai' },
    { key: 'agent.model', value: 'gpt-4o' },
  ]);
  t.true(deps.messages[0].includes('Set agent.model to gpt-4o'));
});

test('setting agent.model without provider flag works normally', (t) => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('agent.model gpt-5.1');

  // Should save the model ID as-is
  t.deepEqual(deps.setCalls, [{ key: 'agent.model', value: 'gpt-5.1' }]);
  t.deepEqual(deps.applied, [{ key: 'agent.model', value: 'gpt-5.1' }]);
  t.true(deps.messages[0].includes('Set agent.model to gpt-5.1'));
});

test('setting agent.mentorModel strips --provider flag and saves mentor provider', (t) => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('agent.mentorModel some/mentor-model --provider=openrouter');

  t.deepEqual(deps.setCalls, [
    { key: 'agent.mentorProvider', value: 'openrouter' },
    { key: 'agent.mentorModel', value: 'some/mentor-model' },
  ]);
  t.deepEqual(deps.applied, [
    { key: 'agent.mentorProvider', value: 'openrouter' },
    { key: 'agent.mentorModel', value: 'some/mentor-model' },
  ]);
});

test('setting tools.editHealingModel strips --provider flag and saves edit healing provider', (t) => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('tools.editHealingModel fast-healer --provider=openrouter');

  t.deepEqual(deps.setCalls, [
    { key: 'tools.editHealingProvider', value: 'openrouter' },
    { key: 'tools.editHealingModel', value: 'fast-healer' },
  ]);
  t.deepEqual(deps.applied, [
    { key: 'tools.editHealingProvider', value: 'openrouter' },
    { key: 'tools.editHealingModel', value: 'fast-healer' },
  ]);
});

test('setting agent.model accepts provider names with spaces', (t) => {
  const providerId = 'opencode go settings command test';
  t.teardown(() => unregisterProvider(providerId));
  upsertProvider({
    id: providerId,
    label: providerId,
    fetchModels: async () => [],
  });
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action(`agent.model deepseek-v4-flash --provider=${providerId}`);

  t.deepEqual(deps.setCalls, [
    { key: 'agent.provider', value: providerId },
    { key: 'agent.model', value: 'deepseek-v4-flash' },
  ]);
  t.deepEqual(deps.applied, [
    { key: 'agent.provider', value: providerId },
    { key: 'agent.model', value: 'deepseek-v4-flash' },
  ]);
});
