import { it, expect } from 'vitest';
import { createSettingsCommand, formatSettingsSummary, parseSettingValue } from './settings-command.js';
import { upsertProvider } from '../providers/index.js';
import type { SettingsWithSources } from '../services/settings/settings-schema.js';
import type { SettingsService } from '../services/settings/settings-service.js';

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
    transport: { value: 'websocket', source: 'default' },
    maxParallelToolCalls: { value: 3, source: 'default' },
  },
  shell: {
    timeout: { value: 120000, source: 'default' },
    maxOutputLines: { value: 1000, source: 'default' },
    maxOutputChars: { value: 40000, source: 'default' },
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
    replaceInput: (_value: string) => {},
  };
};

it('formatSettingsSummary renders values with sources', () => {
  const summary = formatSettingsSummary(baseSettings);

  expect(summary.includes('agent.model: gpt-5.1 (default)')).toBe(true);
  expect(summary.includes('shell.timeout: 120000 (default)')).toBe(true);
  expect(summary.includes('logging.logLevel: info (default)')).toBe(true);
  expect(summary.includes('agent.maxParallelToolCalls: 3 (default)')).toBe(true);
});

it('viewing all settings with no args prompts for autocomplete', () => {
  const deps = createDeps();
  let inputValue = '';
  deps.replaceInput = (value) => {
    inputValue = value;
  };
  const command = createSettingsCommand(deps);
  const result = command.action();

  // Should set input to '/settings ' and return false to keep input active
  expect(result).toBe(false);
  expect(inputValue).toBe('/settings ');
  expect(deps.messages.length).toBe(0); // No message sent
});

it('viewing a single setting shows value and source', () => {
  const deps = createDeps({
    values: { 'agent.model': 'gpt-4o' },
    sources: { 'agent.model': 'cli' },
  });
  const command = createSettingsCommand(deps);
  command.action('agent.model');

  expect(deps.messages.length).toBe(1);
  expect(deps.messages[0].includes('agent.model: gpt-4o (cli)')).toBe(true);
});

it('setting runtime-modifiable values updates service and applies runtime hook', () => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('agent.model gpt-4o');

  expect(deps.setCalls).toEqual([{ key: 'agent.model', value: 'gpt-4o' }]);
  expect(deps.applied).toEqual([{ key: 'agent.model', value: 'gpt-4o' }]);
  expect(deps.messages[0].includes('Set agent.model to gpt-4o')).toBe(true);
});

it('setting agent.maxParallelToolCalls validates positive integers', () => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('agent.maxParallelToolCalls 0');

  expect(deps.setCalls).toEqual([]);
  expect(deps.applied).toEqual([]);
  expect(deps.messages[0].includes('greater than or equal to 1')).toBe(true);
});

it('setting agent.maxParallelToolCalls reports that the new limit applies on the next request', () => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('agent.maxParallelToolCalls 5');

  expect(deps.setCalls).toEqual([{ key: 'agent.maxParallelToolCalls', value: 5 }]);
  expect(deps.applied).toEqual([{ key: 'agent.maxParallelToolCalls', value: 5 }]);
  expect(deps.messages.some((msg) => msg.includes('takes effect on the next request'))).toBe(true);
});

it('resetting agent.maxParallelToolCalls reports that the default applies on the next request', () => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('reset agent.maxParallelToolCalls');

  expect(deps.resetCalls).toEqual(['agent.maxParallelToolCalls']);
  expect(deps.applied).toEqual([{ key: 'agent.maxParallelToolCalls', value: 'value-for-agent.maxParallelToolCalls' }]);
  expect(deps.messages.some((msg) => msg.includes('takes effect on the next request'))).toBe(true);
});

it('refuses to set startup-only values at runtime', () => {
  const deps = createDeps({
    isRuntimeModifiable: (key) => key !== 'agent.maxTurns',
  });
  const command = createSettingsCommand(deps);
  command.action('agent.maxTurns 40');

  expect(deps.setCalls).toEqual([]);
  expect(deps.applied).toEqual([]);
  expect(deps.messages[0].toLowerCase().includes('restart')).toBe(true);
});

it('reset restores defaults and reports action', () => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('reset shell.timeout');

  expect(deps.resetCalls).toEqual(['shell.timeout']);
  expect(deps.messages[0].includes('Reset shell.timeout')).toBe(true);
});

it('parseSettingValue converts common primitives', () => {
  expect(parseSettingValue('42')).toBe(42);
  expect(parseSettingValue('true')).toBe(true);
  expect(parseSettingValue('false')).toBe(false);
  expect(parseSettingValue('gpt-4o')).toBe('gpt-4o');
});

it('setting agent.model strips --provider flag from value', () => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('agent.model mistralai/devstral-2512:free --provider=openrouter');

  // Should save the provider and the model ID
  expect(deps.setCalls).toEqual([
    { key: 'agent.provider', value: 'openrouter' },
    { key: 'agent.model', value: 'mistralai/devstral-2512:free' },
  ]);
  expect(deps.applied).toEqual([
    { key: 'agent.provider', value: 'openrouter' },
    { key: 'agent.model', value: 'mistralai/devstral-2512:free' },
  ]);
  expect(deps.messages[0].includes('Set agent.model to mistralai/devstral-2512:free')).toBe(true);
});

it('setting agent.model strips --provider=openai flag from value', () => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('agent.model gpt-4o --provider=openai');

  // Should save the provider and the model ID
  expect(deps.setCalls).toEqual([
    { key: 'agent.provider', value: 'openai' },
    { key: 'agent.model', value: 'gpt-4o' },
  ]);
  expect(deps.applied).toEqual([
    { key: 'agent.provider', value: 'openai' },
    { key: 'agent.model', value: 'gpt-4o' },
  ]);
  expect(deps.messages[0].includes('Set agent.model to gpt-4o')).toBe(true);
});

it('setting agent.model without provider flag works normally', () => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('agent.model gpt-5.1');

  // Should save the model ID as-is
  expect(deps.setCalls).toEqual([{ key: 'agent.model', value: 'gpt-5.1' }]);
  expect(deps.applied).toEqual([{ key: 'agent.model', value: 'gpt-5.1' }]);
  expect(deps.messages[0].includes('Set agent.model to gpt-5.1')).toBe(true);
});

it('setting agent.mentorModel strips --provider flag and saves mentor provider', () => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('agent.mentorModel some/mentor-model --provider=openrouter');

  expect(deps.setCalls).toEqual([
    { key: 'agent.mentorProvider', value: 'openrouter' },
    { key: 'agent.mentorModel', value: 'some/mentor-model' },
  ]);
  expect(deps.applied).toEqual([
    { key: 'agent.mentorProvider', value: 'openrouter' },
    { key: 'agent.mentorModel', value: 'some/mentor-model' },
  ]);
});

it('setting tools.editHealingModel strips --provider flag and saves edit healing provider', () => {
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action('tools.editHealingModel fast-healer --provider=openrouter');

  expect(deps.setCalls).toEqual([
    { key: 'tools.editHealingProvider', value: 'openrouter' },
    { key: 'tools.editHealingModel', value: 'fast-healer' },
  ]);
  expect(deps.applied).toEqual([
    { key: 'tools.editHealingProvider', value: 'openrouter' },
    { key: 'tools.editHealingModel', value: 'fast-healer' },
  ]);
});

it('setting agent.model accepts provider names with spaces', () => {
  const providerId = 'opencode go settings command test';

  // TODO: // TODO: t.teardown(() => unregisterProvider(providerId)) needs manual try/finally conversion;
  upsertProvider({
    id: providerId,
    label: providerId,
    fetchModels: async () => [],
  });
  const deps = createDeps();
  const command = createSettingsCommand(deps);
  command.action(`agent.model deepseek-v4-flash --provider=${providerId}`);

  expect(deps.setCalls).toEqual([
    { key: 'agent.provider', value: providerId },
    { key: 'agent.model', value: 'deepseek-v4-flash' },
  ]);
  expect(deps.applied).toEqual([
    { key: 'agent.provider', value: providerId },
    { key: 'agent.model', value: 'deepseek-v4-flash' },
  ]);
});
