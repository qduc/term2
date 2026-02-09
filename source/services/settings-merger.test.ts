import test from 'ava';
import { DEFAULT_SETTINGS } from './settings-schema.js';
import { flattenSettings, mergeSettings, trackSettingSources } from './settings-merger.js';

test('flattenSettings: flattens nested objects into dot notation', (t) => {
  t.deepEqual(flattenSettings({ a: { b: 1 }, c: 2 }), { 'a.b': 1, c: 2 });
});

test('mergeSettings: cli > env > config > defaults precedence', (t) => {
  const defaults = DEFAULT_SETTINGS;

  const config = { agent: { model: 'from-config' } } as any;
  const env = { agent: { model: 'from-env' } } as any;
  const cli = { agent: { model: 'from-cli' } } as any;

  const merged = mergeSettings(defaults, config, env, cli, { disableLogging: true });
  t.is(merged.agent.model, 'from-cli');
});

test('trackSettingSources: reports correct source for overridden keys', (t) => {
  const defaults = DEFAULT_SETTINGS;

  const config = { agent: { model: 'from-config' } } as any;
  const env = { agent: { reasoningEffort: 'low' } } as any;
  const cli = { shell: { timeout: 123 } } as any;

  const sources = trackSettingSources(defaults, config, env, cli);

  t.is(sources.get('agent.model'), 'config');
  t.is(sources.get('agent.reasoningEffort'), 'env');
  t.is(sources.get('shell.timeout'), 'cli');
  t.is(sources.get('ui.historySize'), 'default');
});
