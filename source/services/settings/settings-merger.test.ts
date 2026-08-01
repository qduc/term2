import { it, expect } from 'vitest';
import type { SettingsData } from './settings-schema.js';
import { DEFAULT_SETTINGS } from './settings-schema.js';
import { flattenSettings, mergeSettings, trackSettingSources } from './settings-merger.js';
import type { DeepPartial } from './settings-env.js';

it('flattenSettings: flattens nested objects into dot notation', () => {
  expect(flattenSettings({ a: { b: 1 }, c: 2 })).toEqual({ 'a.b': 1, c: 2 });
});

it('mergeSettings: cli > env > config > defaults precedence', () => {
  const defaults = DEFAULT_SETTINGS;

  const config: DeepPartial<SettingsData> = { agent: { model: 'from-config' } };
  const env: DeepPartial<SettingsData> = { agent: { model: 'from-env' } };
  const cli: DeepPartial<SettingsData> = { agent: { model: 'from-cli' } };

  const merged = mergeSettings(defaults, config, env, cli, { disableLogging: true });
  expect(merged.agent.model).toBe('from-cli');
});

it('trackSettingSources: reports correct source for overridden keys', () => {
  const defaults = DEFAULT_SETTINGS;

  const config: DeepPartial<SettingsData> = { agent: { model: 'from-config' } };
  const env: DeepPartial<SettingsData> = { agent: { reasoningEffort: 'low' } };
  const cli: DeepPartial<SettingsData> = { shell: { timeout: 123 } };

  const sources = trackSettingSources(defaults, config, env, cli);

  expect(sources.get('agent.model')).toBe('config');
  expect(sources.get('agent.reasoningEffort')).toBe('env');
  expect(sources.get('shell.timeout')).toBe('cli');
  expect(sources.get('ui.historySize')).toBe('default');
});
