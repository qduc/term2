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
  expect(lastFrame()?.includes('No option matches "zzz"')).toBe(true);
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
  expect(output.includes('❯')).toBe(true);
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
  expect(output.includes('Type a number')).toBe(true);
  expect(output.includes('No option matches')).toBe(false);
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
  expect(output.includes('apply')).toBe(true);
  expect(output.includes('back')).toBe(true);
  expect(output.includes('Tab')).toBe(true);
});

it.sequential(
  'SettingsValueSelectionMenu gives effort and approval pickers human titles and useful descriptions',
  async () => {
    const effort = await renderInAct(
      <SettingsValueSelectionMenu
        settingKey="agent.reasoningEffort"
        items={[{ value: 'default', description: 'Use the model default' }]}
        selectedIndex={0}
        query=""
        defaultText="default"
        currentText="default"
      />,
    );
    expect(effort.lastFrame()).toContain('Reasoning effort');
    expect(effort.lastFrame()).not.toContain('Default: default');
    expect(effort.lastFrame()).toContain('Use the model default');
    const approval = await renderInAct(
      <SettingsValueSelectionMenu
        settingKey="shell.autoApproveMode"
        items={[{ value: 'auto', description: 'LLM risk check; workspace edits stay automatic' }]}
        selectedIndex={0}
        query=""
      />,
    );
    expect(approval.lastFrame()).toContain('Auto-approve mode');
    expect(approval.lastFrame()).toContain('LLM risk check');
  },
);

it.sequential('SettingsValueSelectionMenu formats duration choices consistently with duration values', async () => {
  for (const [settingKey, value, formatted] of [
    ['shell.timeout', '120000', '2m'],
    ['agent.runBudget.maxActiveTimeMs', '1800000', '30m'],
  ]) {
    const { lastFrame } = await renderInAct(
      <SettingsValueSelectionMenu settingKey={settingKey} items={[{ value }]} selectedIndex={0} query="" />,
    );
    expect(lastFrame()).toContain(formatted);
    expect(lastFrame()).not.toContain(value);
  }
});
it.sequential('SettingsValueSelectionMenu shows a neutral state for free-form string settings', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsValueSelectionMenu settingKey="webSearch.exa.apiKey" items={[]} selectedIndex={0} query="" />,
  );
  const output = lastFrame() ?? '';
  expect(output.includes('Type a value')).toBe(true);
  expect(output.includes('Type a value, then press Enter')).toBe(true);
  expect(output.includes('No option matches')).toBe(false);
});

it.sequential('SettingsValueSelectionMenu keeps curated string no-match neutral, not a red error', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsValueSelectionMenu settingKey="agent.provider" items={[]} selectedIndex={0} query="custom-provider" />,
  );
  const output = lastFrame() ?? '';
  expect(output.includes('Type a value')).toBe(true);
  expect(output.includes('No suggestion matches — Enter saves what you typed')).toBe(true);
  expect(output.includes('No option matches')).toBe(false);
});

it.sequential('SettingsValueSelectionMenu keeps the red state for enum no-match (a real dead end)', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsValueSelectionMenu settingKey="logging.logLevel" items={[]} selectedIndex={0} query="banana" />,
  );
  const output = lastFrame() ?? '';
  expect(output.includes('No option matches "banana"')).toBe(true);
  expect(output.includes('Type a value')).toBe(false);
});
