import { it, expect } from 'vitest';
import { SETTINGS_CATEGORIES } from './settings-completion-config.js';
import { clampIndex, filterSettingsByCategory, getSettingCategory } from './settings-completion-logic.js';

it('settings completion config exposes stable category ids', () => {
  expect(SETTINGS_CATEGORIES.map((item) => item.id)).toEqual(['models', 'safety', 'tools', 'ui', 'misc']);
});

it('getSettingCategory maps known keys to expected categories', () => {
  expect(getSettingCategory('agent.model').id).toBe('models');
  expect(getSettingCategory('shell.timeout').id).toBe('tools');
  expect(getSettingCategory('agent.subagentWorkerModel').id).toBe('models');
  expect(getSettingCategory('totally.unknown').id).toBe('misc');
});

it('filterSettingsByCategory keeps only entries from the requested category', () => {
  const result = filterSettingsByCategory(
    [{ key: 'agent.model' }, { key: 'shell.timeout' }, { key: 'webSearch.provider' }],
    'tools',
  );

  expect(result).toEqual([{ key: 'shell.timeout' }, { key: 'webSearch.provider' }]);
});

it('clampIndex keeps the index in range', () => {
  expect(clampIndex(0, 0)).toBe(0);
  expect(clampIndex(-3, 5)).toBe(0);
  expect(clampIndex(2, 5)).toBe(2);
  expect(clampIndex(7, 5)).toBe(4);
});
