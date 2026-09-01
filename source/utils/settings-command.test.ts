import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettingsCommand, formatSettingsSummary, parseSettingValue } from './settings-command.js';
import { upsertProvider } from '../providers/index.js';
import type { SettingsWithSources } from '../services/settings/settings-schema.js';
import { SettingsService } from '../services/settings/settings-service.js';

const baseSettings = {
  agent: {
    model: { value: 'gpt-5.1', source: 'default' },
    efficientModel: { value: 'gpt-5-mini', source: 'config' },
    capableModel: { value: undefined, source: 'default' },
    reasoningEffort: { value: 'default', source: 'default' },
    temperature: { value: undefined, source: 'default' },
    mentorModel: { value: undefined, source: 'default' },
    mentorProvider: { value: undefined, source: 'default' },
    mentorReasoningEffort: { value: 'default', source: 'default' },
    mentorSamples: { value: 1, source: 'default' },
    useFlexServiceTier: { value: false, source: 'default' },
    contextCompaction: {
      enabled: { value: false, source: 'default' },
      mode: { value: 'native', source: 'default' },
      compactThreshold: { value: 0.8, source: 'default' },
      compactThresholdTokens: { value: null, source: 'default' },
    },
    provider: { value: 'openai', source: 'default' },
    maxTurns: { value: 20, source: 'default' },
    retryAttempts: { value: 2, source: 'default' },
    transport: { value: 'websocket', source: 'default' },
    maxParallelToolCalls: { value: 3, source: 'default' },
    runBudget: {
      maxUsdMicros: { value: 5_000_000, source: 'default' },
      maxUnpricedTokens: { value: 500_000, source: 'default' },
      maxActiveTimeMs: { value: 3_600_000, source: 'default' },
      warningHeadroomUsdMicros: { value: 1_000_000, source: 'default' },
      warningHeadroomUnpricedTokens: { value: 100_000, source: 'default' },
      warningHeadroomActiveTimeMs: { value: 900_000, source: 'default' },
      softHeadroomUsdMicros: { value: 250_000, source: 'default' },
      softHeadroomUnpricedTokens: { value: 25_000, source: 'default' },
      softHeadroomActiveTimeMs: { value: 300_000, source: 'default' },
      turnBackstop: { value: 150, source: 'default' },
      extensionPercent: { value: 50, source: 'default' },
      maxParentExtensions: { value: 2, source: 'default' },
      identicalToolCallThreshold: { value: 3, source: 'default' },
      escalation: { value: 'warn', source: 'default' },
    },
    backgroundCheckIn: {
      enabled: { value: true, source: 'default' },
      intervalMs: { value: 300_000, source: 'default' },
    },
  },
  shell: {
    timeout: { value: 120000, source: 'default' },
    backgroundTimeout: { value: 1800000, source: 'default' },
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
  memory: {
    enabled: { value: true, source: 'default' },
  },
  subagent: {
    asyncSessionTtlMs: { value: 30 * 60 * 1000, source: 'default' },
    asyncMessageCap: { value: 50, source: 'default' },
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
    get: (key: any): any => overrides.values?.[key] ?? 'value-for-' + key,
    getDynamic: (key: string): unknown => overrides.values?.[key] ?? 'value-for-' + key,
    getSource: (key: string) => overrides.sources?.[key] ?? 'default',
    reset: (key: string) => resetCalls.push(key),
    isRuntimeModifiable: overrides.isRuntimeModifiable || (() => true),
    set: (key: any, value: unknown) => setCalls.push({ key, value }),
    setDynamic: (key: string, value: unknown) => setCalls.push({ key, value }),
    setPersistent: (key: any, value: unknown) => setCalls.push({ key, value }),
    setPersistentDynamic: (key: string, value: unknown) => setCalls.push({ key, value }),
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
  expect(summary.includes('agent.efficientModel: gpt-5-mini (config)')).toBe(true);
  expect(summary.includes('agent.capableModel: undefined (default)')).toBe(true);
  expect(summary.includes('shell.timeout: 120000 (default)')).toBe(true);
  expect(summary.includes('shell.backgroundTimeout: 1800000 (default)')).toBe(true);
  expect(summary.includes('logging.logLevel: info (default)')).toBe(true);
  expect(summary.includes('agent.maxParallelToolCalls: 3 (default)')).toBe(true);
  expect(summary.includes('agent.contextCompaction.enabled: false (default)')).toBe(true);
  expect(summary.includes('agent.contextCompaction.compactThreshold: 0.8 (default)')).toBe(true);
  expect(summary.includes('agent.contextCompaction.mode: native (default)')).toBe(true);
  expect(summary.includes('agent.contextCompaction.compactThresholdTokens: null (default)')).toBe(true);
  expect(summary.includes('agent.runBudget.maxUsdMicros: 5000000 (default)')).toBe(true);
  expect(summary.includes('agent.runBudget.identicalToolCallThreshold: 3 (default)')).toBe(true);
  expect(summary.includes('agent.runBudget.escalation: warn (default)')).toBe(true);
  expect(summary.includes('agent.backgroundCheckIn.enabled: true (default)')).toBe(true);
  expect(summary.includes('agent.backgroundCheckIn.intervalMs: 300000 (default)')).toBe(true);
  expect(summary.includes('memory.enabled: true (default)')).toBe(true);
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

it('queues an implicit Plan Mode exit when /settings enables an exclusive mode', () => {
  let planMode = true;
  const applied: Array<{ key: string; value: unknown }> = [];
  const command = createSettingsCommand({
    settingsService: {
      get: (key: string) => (key === 'app.planMode' ? planMode : false),
      getDynamic: () => false,
      isRuntimeModifiable: () => true,
      setDynamic: (key: string) => {
        if (key === 'app.liteMode') planMode = false;
        return { status: 'saved' };
      },
    } as any,
    addSystemMessage: () => {},
    applyRuntimeSetting: (key, value) => {
      applied.push({ key, value });
    },
    replaceInput: () => {},
  });

  command.action('app.liteMode true');

  expect(applied).toEqual([
    { key: 'app.liteMode', value: true },
    { key: 'app.planMode', value: false },
  ]);
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

it('does not claim a failed durable replacement succeeded', () => {
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-settings-command-'));
  const messages: string[] = [];
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
    disableFilePersistence: false,
  });
  service.set('agent.model', 'predecessor-model');

  const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw new Error('rename failed');
  });

  try {
    const command = createSettingsCommand({
      settingsService: service,
      addSystemMessage: (message) => messages.push(message),
      applyRuntimeSetting: () => {},
      replaceInput: () => {},
    });

    command.action('agent.model replacement-model');

    const freshService = new SettingsService({
      settingsDir,
      disableLogging: true,
      disableFilePersistence: false,
    });
    expect(freshService.get('agent.model')).toBe('predecessor-model');
    expect(messages).not.toContain('Set agent.model to replacement-model');
    expect(messages.some((message) => message.includes('failed to save agent.model to disk'))).toBe(true);
  } finally {
    rename.mockRestore();
    fs.rmSync(settingsDir, { recursive: true, force: true });
  }
});

it('reports a memory-only outcome when persistence is disabled', () => {
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-settings-command-'));
  const messages: string[] = [];
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  try {
    const command = createSettingsCommand({
      settingsService: service,
      addSystemMessage: (message) => messages.push(message),
      applyRuntimeSetting: () => {},
      replaceInput: () => {},
    });

    command.action('agent.model gpt-5.1');

    expect(messages.some((message) => message.includes('memory only'))).toBe(true);
  } finally {
    fs.rmSync(settingsDir, { recursive: true, force: true });
  }
});

// President decision 2026-08-16: direct credential display in `/settings` is
// accepted policy (no redaction for direct leaf queries). This green test
// characterizes the decided behavior so a later redaction change is a
// deliberate, recorded decision rather than an accidental one.
it('renders direct credential bytes in /settings queries (President decision: display accepted)', () => {
  const secret = 'sk-direct-leaf-secret';
  const deps = createDeps({ values: { 'agent.openai.apiKey': secret } });
  const command = createSettingsCommand(deps);

  command.action('agent.openai.apiKey');

  expect(deps.messages).toHaveLength(1);
  expect(deps.messages[0]).toContain(secret);
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
