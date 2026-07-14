import { it, expect } from 'vitest';
import { SETTINGS_CATEGORIES } from './settings-completion-config.js';
import { clampIndex, filterSettingsByCategory, getSettingCategory } from './settings-completion-logic.js';

it('settings completion config exposes stable category ids', () => {
  expect(SETTINGS_CATEGORIES.map((item) => item.id)).toEqual(['models', 'safety', 'tools', 'ui', 'memory', 'misc']);
});

it('getSettingCategory maps known keys to expected categories', () => {
  expect(getSettingCategory('agent.model').id).toBe('models');
  expect(getSettingCategory('agent.smartModel').id).toBe('models');
  expect(getSettingCategory('agent.balancedModel').id).toBe('models');
  expect(getSettingCategory('agent.cheapModel').id).toBe('models');
  expect(getSettingCategory('agent.choreModel').id).toBe('models');
  expect(getSettingCategory('shell.timeout').id).toBe('tools');
  expect(getSettingCategory('agent.subagentWorkerModel').id).toBe('models');
  expect(getSettingCategory('memory.enabled').id).toBe('memory');
  expect(getSettingCategory('memory.directory').id).toBe('memory');
  expect(getSettingCategory('memory.contextBudgetChars').id).toBe('memory');
  expect(getSettingCategory('memory.searchDefaultLimit').id).toBe('memory');
  expect(getSettingCategory('memory.searchMaxLimit').id).toBe('memory');
  expect(getSettingCategory('totally.unknown').id).toBe('misc');
});

it('filterSettingsByCategory keeps only entries from the requested category', () => {
  const result = filterSettingsByCategory(
    [{ key: 'agent.model' }, { key: 'shell.timeout' }, { key: 'webSearch.provider' }, { key: 'memory.enabled' }],
    'tools',
  );

  expect(result).toEqual([{ key: 'shell.timeout' }, { key: 'webSearch.provider' }]);
});

it('filterSettingsByCategory returns memory entries for the memory category', () => {
  const result = filterSettingsByCategory(
    [
      { key: 'memory.enabled' },
      { key: 'memory.directory' },
      { key: 'memory.contextBudgetChars' },
      { key: 'memory.searchDefaultLimit' },
      { key: 'memory.searchMaxLimit' },
      { key: 'agent.model' },
    ],
    'memory',
  );

  expect(result).toEqual([
    { key: 'memory.enabled' },
    { key: 'memory.directory' },
    { key: 'memory.contextBudgetChars' },
    { key: 'memory.searchDefaultLimit' },
    { key: 'memory.searchMaxLimit' },
  ]);
});

it('clampIndex keeps the index in range', () => {
  expect(clampIndex(0, 0)).toBe(0);
  expect(clampIndex(-3, 5)).toBe(0);
  expect(clampIndex(2, 5)).toBe(2);
  expect(clampIndex(7, 5)).toBe(4);
});
