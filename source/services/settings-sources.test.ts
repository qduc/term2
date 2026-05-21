import test from 'ava';
import { DEFAULT_SETTINGS, type SettingsData, type SettingSource } from './settings-schema.js';
import { buildSettingsWithSources } from './settings-sources.js';

test('buildSettingsWithSources maps nested values and sources including optional undefined fields', (t) => {
  const settings: SettingsData = {
    ...DEFAULT_SETTINGS,
    agent: {
      ...DEFAULT_SETTINGS.agent,
      temperature: undefined,
    },
    webSearch: {
      ...DEFAULT_SETTINGS.webSearch,
      tavily: undefined,
    },
  };

  const getSource = (key: string): SettingSource => {
    if (key === 'agent.model') {
      return 'cli';
    }

    if (key === 'webSearch.tavily') {
      return 'env';
    }

    return 'default';
  };

  const result = buildSettingsWithSources(settings, getSource);

  t.is(result.agent.model.value, settings.agent.model);
  t.is(result.agent.model.source, 'cli');
  t.is(result.agent.temperature.value, undefined);
  t.is(result.agent.temperature.source, 'default');
  t.is(result.webSearch.tavily.value, undefined);
  t.is(result.webSearch.tavily.source, 'env');
  t.deepEqual(result.webSearch.provider.value, settings.webSearch.provider);
  t.is(result.app.planMode.value, settings.app.planMode);
  t.is(result.app.planMode.source, 'default');
  t.is(result.app.orchestratorMode.value, settings.app.orchestratorMode);
  t.is(result.app.orchestratorMode.source, 'default');
});
