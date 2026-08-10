import { it, expect } from 'vitest';
import { DEFAULT_SETTINGS, type SettingsData, type SettingSource } from './settings-schema.js';
import { buildSettingsWithSources } from './settings-sources.js';

it('buildSettingsWithSources maps nested values and sources including optional undefined fields', () => {
  const settings: SettingsData = {
    ...DEFAULT_SETTINGS,
    agent: {
      ...DEFAULT_SETTINGS.agent,
      temperature: undefined,
      smartModel: 'smart-model',
      smartProvider: 'smart-provider',
      codex: {
        websocketFirstFrameTimeoutMs: 12_345,
        websocketInterFrameTimeoutMs: 67_890,
      },
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

    if (key === 'agent.codex.websocketFirstFrameTimeoutMs') {
      return 'config';
    }

    if (key === 'agent.smartModel') {
      return 'config';
    }

    return 'default';
  };

  const result = buildSettingsWithSources(settings, getSource);

  expect(result.agent.model.value).toBe(settings.agent.model);
  expect(result.agent.model.source).toBe('cli');
  expect(result.agent.temperature.value).toBe(undefined);
  expect(result.agent.temperature.source).toBe('default');
  expect(result.agent.smartModel.value).toBe('smart-model');
  expect(result.agent.smartModel.source).toBe('config');
  expect(result.agent.smartProvider.value).toBe('smart-provider');
  expect(result.agent.smartProvider.source).toBe('default');
  expect(result.webSearch.tavily.value).toBe(undefined);
  expect(result.webSearch.tavily.source).toBe('env');
  expect(result.webSearch.provider.value).toEqual(settings.webSearch.provider);
  expect(result.app.planMode.value).toBe(settings.app.planMode);
  expect(result.app.planMode.source).toBe('default');
  expect(result.app.orchestratorMode.value).toBe(settings.app.orchestratorMode);
  expect(result.app.orchestratorMode.source).toBe('default');
  expect(result.agent.maxParallelToolCalls.value).toBe(settings.agent.maxParallelToolCalls);
  expect(result.agent.maxParallelToolCalls.source).toBe('default');
  expect(result.sandbox.dockerHostControlProjects.value).toEqual([]);
  expect(result.sandbox.dockerHostControlProjects.source).toBe('default');
  const codex = result.agent.codex as unknown as {
    websocketFirstFrameTimeoutMs: { value: number; source: SettingSource };
    websocketInterFrameTimeoutMs: { value: number; source: SettingSource };
  };
  expect(codex.websocketFirstFrameTimeoutMs.value).toBe(12_345);
  expect(codex.websocketFirstFrameTimeoutMs.source).toBe('config');
  expect(codex.websocketInterFrameTimeoutMs.value).toBe(67_890);
  expect(codex.websocketInterFrameTimeoutMs.source).toBe('default');
});

// Regression: sandbox.allowNetworking existed in the zod schema, SETTING_KEYS,
// RUNTIME_MODIFIABLE_SETTINGS and DEFAULT_SETTINGS, but was missing from both
// SettingsWithSources and the SETTINGS_SOURCE_KEYS runtime map, so `/settings`
// could not report where its value came from. The source map is a plain object
// literal with no compiler link to the schema, so nothing caught the omission.
it('reports a source for every sandbox setting, including allowNetworking', () => {
  const withSources = buildSettingsWithSources(DEFAULT_SETTINGS, () => 'default');
  expect(withSources.sandbox.allowNetworking).toBeDefined();
  expect(withSources.sandbox.allowNetworking.source).toBe('default');
});

it('reports a source and value for shell.backgroundTimeout', () => {
  const withSources = buildSettingsWithSources(DEFAULT_SETTINGS, () => 'default');
  expect(withSources.shell.backgroundTimeout).toBeDefined();
  expect(withSources.shell.backgroundTimeout.value).toBe(30 * 60 * 1000);
  expect(withSources.shell.backgroundTimeout.source).toBe('default');
});
