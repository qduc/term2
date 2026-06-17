import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { DEFAULT_SETTINGS } from './settings-schema.js';
import { flattenSettings, mergeSettings, trackSettingSources } from './settings-merger.js';

it('flattenSettings: flattens nested objects into dot notation', () => {
  expect(flattenSettings({ a: { b: 1 }, c: 2 })).toEqual({ 'a.b': 1, c: 2 });
});

it('mergeSettings: cli > env > config > defaults precedence', () => {
  const defaults = DEFAULT_SETTINGS;

  const config = { agent: { model: 'from-config' } } as any;
  const env = { agent: { model: 'from-env' } } as any;
  const cli = { agent: { model: 'from-cli' } } as any;

  const merged = mergeSettings(defaults, config, env, cli, { disableLogging: true });
  expect(merged.agent.model).toBe('from-cli');
});

it('trackSettingSources: reports correct source for overridden keys', () => {
  const defaults = DEFAULT_SETTINGS;

  const config = { agent: { model: 'from-config' } } as any;
  const env = { agent: { reasoningEffort: 'low' } } as any;
  const cli = { shell: { timeout: 123 } } as any;

  const sources = trackSettingSources(defaults, config, env, cli);

  expect(sources.get('agent.model')).toBe('config');
  expect(sources.get('agent.reasoningEffort')).toBe('env');
  expect(sources.get('shell.timeout')).toBe('cli');
  expect(sources.get('ui.historySize')).toBe('default');
});
