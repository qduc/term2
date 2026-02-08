import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import SettingsSelectionMenu from './SettingsSelectionMenu.js';
import type { SettingCompletionItem } from '../hooks/use-settings-completion.js';

const items: SettingCompletionItem[] = [
  {
    key: 'agent.model',
    description: 'The AI model to use',
    currentValue: 'gpt-5',
  },
  {
    key: 'shell.timeout',
    description: 'Shell command timeout in milliseconds',
    currentValue: 120000,
  },
];

test('SettingsSelectionMenu renders empty state (does not disappear)', (t) => {
  const { lastFrame } = render(<SettingsSelectionMenu items={[]} selectedIndex={0} query="abc" />);
  t.true(lastFrame()?.includes('No settings match'));
  t.true(lastFrame()?.includes('abc'));
});

test('SettingsSelectionMenu shows query and suggestion count', (t) => {
  const { lastFrame } = render(<SettingsSelectionMenu items={items} selectedIndex={0} query="ag" />);
  const output = lastFrame() ?? '';
  t.true(output.includes('ag'));
  t.true(output.includes('2 items'));
});

test('SettingsSelectionMenu shows category headers', (t) => {
  const { lastFrame } = render(<SettingsSelectionMenu items={items} selectedIndex={0} query="" />);
  const output = lastFrame() ?? '';
  t.true(output.includes('Common Settings'));
});

test('SettingsSelectionMenu marks the selected item', (t) => {
  const { lastFrame } = render(<SettingsSelectionMenu items={items} selectedIndex={1} query="" />);
  const output = lastFrame() ?? '';
  // We mark selected rows with a leading arrow
  t.true(output.includes('▶'));
  t.true(output.includes('shell.timeout'));
});
