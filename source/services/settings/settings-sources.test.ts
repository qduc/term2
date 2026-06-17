import { it, expect } from 'vitest';
import { DEFAULT_SETTINGS, type SettingsData, type SettingSource } from './settings-schema.js';
import { buildSettingsWithSources } from './settings-sources.js';

it('buildSettingsWithSources maps nested values and sources including optional undefined fields', () => {
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

  expect(result.agent.model.value).toBe(settings.agent.model);
  expect(result.agent.model.source).toBe('cli');
  expect(result.agent.temperature.value).toBe(undefined);
  expect(result.agent.temperature.source).toBe('default');
  expect(result.webSearch.tavily.value).toBe(undefined);
  expect(result.webSearch.tavily.source).toBe('env');
  expect(result.webSearch.provider.value).toEqual(settings.webSearch.provider);
  expect(result.app.planMode.value).toBe(settings.app.planMode);
  expect(result.app.planMode.source).toBe('default');
  expect(result.app.orchestratorMode.value).toBe(settings.app.orchestratorMode);
  expect(result.app.orchestratorMode.source).toBe('default');
  expect(result.agent.maxParallelToolCalls.value).toBe(settings.agent.maxParallelToolCalls);
  expect(result.agent.maxParallelToolCalls.source).toBe('default');
});
