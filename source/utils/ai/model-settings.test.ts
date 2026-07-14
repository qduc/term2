import { expect, it } from 'vitest';
import { MODEL_SETTING_CONFIGS, getModelSettingConfigForInput } from './model-settings.js';

it('prioritizes the main and flat ancillary tiers while recognizing legacy commands', () => {
  expect(MODEL_SETTING_CONFIGS.slice(0, 5).map(({ modelKey }) => modelKey)).toEqual([
    'agent.model',
    'agent.smartModel',
    'agent.balancedModel',
    'agent.cheapModel',
    'agent.choreModel',
  ]);

  expect(getModelSettingConfigForInput('/settings agent.cheapModel ')).toMatchObject({
    providerKey: 'agent.cheapProvider',
    fallbackProviderKey: 'agent.provider',
  });
  expect(getModelSettingConfigForInput('/settings agent.efficientModel ')).toMatchObject({
    providerKey: 'agent.provider',
  });
});
