import { expect, it } from 'vitest';
import { MODEL_SETTING_CONFIGS, getModelSettingConfigForInput } from './model-settings.js';

it('contains only the main and flat ancillary tiers', () => {
  expect(MODEL_SETTING_CONFIGS.map(({ modelKey }) => modelKey)).toEqual([
    'agent.modelSelection',
    'agent.smartModel',
    'agent.balancedModel',
    'agent.cheapModel',
    'agent.choreModel',
  ]);

  expect(getModelSettingConfigForInput('/settings agent.cheapModel ')).toMatchObject({
    modelKey: 'agent.cheapModel',
    pool: true,
  });
  expect(getModelSettingConfigForInput('/settings agent.efficientModel ')).toBeUndefined();
});
