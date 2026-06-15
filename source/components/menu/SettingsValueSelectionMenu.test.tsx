// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import SettingsValueSelectionMenu from './SettingsValueSelectionMenu.js';
import type { SettingValueSuggestion } from '../../hooks/use-settings-value-completion.js';

const suggestions: SettingValueSuggestion[] = [
  { value: 'low', description: 'Lower reasoning cost' },
  { value: 'medium', description: 'Balanced' },
  { value: 'high', description: 'Highest reasoning' },
];

test.serial('SettingsValueSelectionMenu renders empty state', async (t) => {
  const { lastFrame } = await renderInAct(
    <SettingsValueSelectionMenu settingKey="agent.reasoningEffort" items={[]} selectedIndex={0} query="zzz" />,
    t,
  );
  t.true(lastFrame()?.includes('No values match'));
  t.true(lastFrame()?.includes('zzz'));
});

test.serial('SettingsValueSelectionMenu shows suggestions list', async (t) => {
  const { lastFrame } = await renderInAct(
    <SettingsValueSelectionMenu settingKey="agent.reasoningEffort" items={suggestions} selectedIndex={0} query="" />,
    t,
  );
  const output = lastFrame() ?? '';
  t.true(output.includes('low'));
  t.true(output.includes('Lower reasoning cost'));
  t.true(output.includes('medium'));
  t.true(output.includes('high'));
});

test.serial('SettingsValueSelectionMenu marks the selected value', async (t) => {
  const { lastFrame } = await renderInAct(
    <SettingsValueSelectionMenu settingKey="agent.reasoningEffort" items={suggestions} selectedIndex={2} query="" />,
    t,
  );
  const output = lastFrame() ?? '';
  t.true(output.includes('▶'));
  t.true(output.includes('high'));
});

test.serial('SettingsValueSelectionMenu shows numeric hint when applicable (empty state)', async (t) => {
  const { lastFrame } = await renderInAct(
    <SettingsValueSelectionMenu
      settingKey="agent.temperature"
      items={[]}
      selectedIndex={0}
      query="invalid"
      isNumericSettings={true}
    />,
    t,
  );
  const output = lastFrame() ?? '';
  t.true(output.includes('This setting accepts numeric values'));
});

test.serial('SettingsValueSelectionMenu renders footer', async (t) => {
  const { lastFrame } = await renderInAct(
    <SettingsValueSelectionMenu
      settingKey="agent.temperature"
      items={[{ value: '0', description: 'Zero' }]}
      selectedIndex={0}
      query=""
      isNumericSettings={true}
    />,
    t,
  );
  const output = lastFrame() ?? '';
  t.true(output.includes('confirm'));
  t.true(output.includes('cancel'));
});
