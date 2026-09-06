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

it.sequential(
  'SettingsValueSelectionMenu shows suggestions list and highlighted item description at the bottom footer',
  async () => {
    const { lastFrame } = await renderInAct(
      <SettingsValueSelectionMenu settingKey="agent.reasoningEffort" items={suggestions} selectedIndex={0} query="" />,
    );
    const output = lastFrame() ?? '';
    expect(output.includes('low')).toBe(true);
    expect(output.includes('Lower reasoning cost')).toBe(true);
    expect(output.includes('medium')).toBe(true);
    expect(output.includes('high')).toBe(true);
    expect(output.includes('Balanced')).toBe(false);
    expect(output.includes('Highest reasoning')).toBe(false);
  },
);

it.sequential('SettingsValueSelectionMenu marks the selected value and updates bottom description', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsValueSelectionMenu settingKey="agent.reasoningEffort" items={suggestions} selectedIndex={2} query="" />,
  );
  const output = lastFrame() ?? '';
  expect(output.includes('▶')).toBe(true);
  expect(output.includes('high')).toBe(true);
  expect(output.includes('Highest reasoning')).toBe(true);
  expect(output.includes('Lower reasoning cost')).toBe(false);
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
  expect(output.includes('Zero')).toBe(true);
  expect(output.includes('confirm')).toBe(true);
  expect(output.includes('cancel')).toBe(true);
});
it.sequential('SettingsValueSelectionMenu shows a neutral state for free-form string settings', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsValueSelectionMenu settingKey="webSearch.exa.apiKey" items={[]} selectedIndex={0} query="" />,
  );
  const output = lastFrame() ?? '';
  expect(output.includes('Type a value')).toBe(true);
  expect(output.includes('No predefined values — type freely')).toBe(true);
  expect(output.includes('No values match')).toBe(false);
});

it.sequential('SettingsValueSelectionMenu keeps curated string no-match neutral, not a red error', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsValueSelectionMenu settingKey="agent.provider" items={[]} selectedIndex={0} query="custom-provider" />,
  );
  const output = lastFrame() ?? '';
  expect(output.includes('Type a value')).toBe(true);
  expect(output.includes('Enter applies the typed value')).toBe(true);
  expect(output.includes('No values match')).toBe(false);
});

it.sequential('SettingsValueSelectionMenu keeps the red state for enum no-match (a real dead end)', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsValueSelectionMenu settingKey="logging.logLevel" items={[]} selectedIndex={0} query="banana" />,
  );
  const output = lastFrame() ?? '';
  expect(output.includes('No values match')).toBe(true);
  expect(output.includes('Type a value')).toBe(false);
});
