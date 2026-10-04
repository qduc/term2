import { it, expect } from 'vitest';
import type { SettingsData } from './settings-schema.js';
import { DEFAULT_SETTINGS } from './settings-schema.js';
import { flattenSettings, mergeSettings, trackSettingSources } from './settings-merger.js';
import type { DeepPartial } from './settings-env.js';

it('flattenSettings: flattens nested objects into dot notation', () => {
  expect(flattenSettings({ a: { b: 1 }, c: 2 })).toEqual({ 'a.b': 1, c: 2 });
  expect(flattenSettings({ agent: { modelSelection: { model: 'chosen', provider: 'zai' } } })).toEqual({
    'agent.modelSelection': { model: 'chosen', provider: 'zai' },
  });
});

it('rejects legacy higher-priority scalar inputs rather than rebinding a prior selection', () => {
  const merged = mergeSettings(
    DEFAULT_SETTINGS,
    { agent: { modelSelection: { model: 'file-model', provider: 'zai' } } },
    { agent: { model: 'env-model' } } as never,
    { agent: { provider: 'codex' } } as never,
    { disableLogging: true },
  );
  expect(merged).toBe(DEFAULT_SETTINGS);
});

it('does not complete a partial explicit selection from a lower-priority layer', () => {
  const merged = mergeSettings(
    DEFAULT_SETTINGS,
    {},
    {},
    { agent: { modelSelection: { model: 'incomplete' } } },
    { disableLogging: true },
  );
  expect(merged).toBe(DEFAULT_SETTINGS);
});

it('mergeSettings: cli > env > config > defaults precedence', () => {
  const defaults = DEFAULT_SETTINGS;

  const config: DeepPartial<SettingsData> = { agent: { modelSelection: { model: 'from-config', provider: 'config-host' } } };
  const env: DeepPartial<SettingsData> = { agent: { modelSelection: { model: 'from-env', provider: 'env-host' } } };
  const cli: DeepPartial<SettingsData> = { agent: { modelSelection: { model: 'from-cli', provider: 'cli-host' } } };

  const merged = mergeSettings(defaults, config, env, cli, { disableLogging: true });
  expect(merged.agent.modelSelection).toEqual({ model: 'from-cli', provider: 'cli-host' });
});

it('trackSettingSources: reports correct source for overridden keys', () => {
  const defaults = DEFAULT_SETTINGS;

  const config: DeepPartial<SettingsData> = { agent: { modelSelection: { model: 'from-config', provider: 'config-host' } } };
  const env: DeepPartial<SettingsData> = { agent: { reasoningEffort: 'low' } };
  const cli: DeepPartial<SettingsData> = { shell: { timeout: 123 } };

  const sources = trackSettingSources(defaults, config, env, cli);

  expect(sources.get('agent.modelSelection')).toBe('config');
  expect(sources.get('agent.reasoningEffort')).toBe('env');
  expect(sources.get('shell.timeout')).toBe('cli');
  expect(sources.get('ui.historySize')).toBe('default');
});
