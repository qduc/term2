// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import SettingsValueSelectionMenu from './SettingsValueSelectionMenu.js';
import type { SettingValueSuggestion } from '../../utils/value-suggestions.js';

const suggestions: SettingValueSuggestion[] = [
  { value: 'low', description: 'Lower reasoning cost' },
  { value: 'medium', description: 'Balanced' },
  { value: 'high', description: 'Highest reasoning' },
];

it.sequential('SettingsValueSelectionMenu renders empty state', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsValueSelectionMenu settingKey="agent.reasoningEffort" items={[]} selectedIndex={0} query="zzz" />,
  );
  expect(lastFrame()?.includes('No values match')).toBe(true);
  expect(lastFrame()?.includes('zzz')).toBe(true);
});

it.sequential('SettingsValueSelectionMenu shows suggestions list', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsValueSelectionMenu settingKey="agent.reasoningEffort" items={suggestions} selectedIndex={0} query="" />,
  );
  const output = lastFrame() ?? '';
  expect(output.includes('low')).toBe(true);
  expect(output.includes('Lower reasoning cost')).toBe(true);
  expect(output.includes('medium')).toBe(true);
  expect(output.includes('high')).toBe(true);
});

it.sequential('SettingsValueSelectionMenu marks the selected value', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsValueSelectionMenu settingKey="agent.reasoningEffort" items={suggestions} selectedIndex={2} query="" />,
  );
  const output = lastFrame() ?? '';
  expect(output.includes('▶')).toBe(true);
  expect(output.includes('high')).toBe(true);
});

it.sequential('SettingsValueSelectionMenu shows numeric hint when applicable (empty state)', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsValueSelectionMenu
      settingKey="agent.temperature"
      items={[]}
      selectedIndex={0}
      query="invalid"
      isNumericSettings={true}
    />,
  );
  const output = lastFrame() ?? '';
  expect(output.includes('This setting accepts numeric values')).toBe(true);
});

it.sequential('SettingsValueSelectionMenu renders footer', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsValueSelectionMenu
      settingKey="agent.temperature"
      items={[{ value: '0', description: 'Zero' }]}
      selectedIndex={0}
      query=""
      isNumericSettings={true}
    />,
  );
  const output = lastFrame() ?? '';
  expect(output.includes('confirm')).toBe(true);
  expect(output.includes('cancel')).toBe(true);
});
