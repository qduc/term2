// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import SettingsSelectionMenu from './SettingsSelectionMenu.js';
import type { SettingCompletionItem } from '../../hooks/use-settings-completion.js';

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

const defaultTabs = {
  activeCategoryId: 'model',
  categories: [
    { id: 'model', label: 'Model & Reasoning' },
    { id: 'shell', label: 'Shell Execution' },
  ],
};

test('SettingsSelectionMenu renders empty state (does not disappear)', (t) => {
  const { lastFrame } = render(
    React.createElement(SettingsSelectionMenu, {
      items: [],
      selectedIndex: 0,
      query: 'abc',
      activeCategoryId: defaultTabs.activeCategoryId,
      categories: defaultTabs.categories,
    }),
  );
  t.true(lastFrame()?.includes('No settings match'));
  t.true(lastFrame()?.includes('abc'));
});

test('SettingsSelectionMenu renders settings list and their current values', (t) => {
  const { lastFrame } = render(
    React.createElement(SettingsSelectionMenu, {
      items,
      selectedIndex: 0,
      query: 'ag',
      isSearchingAll: true,
      activeCategoryId: defaultTabs.activeCategoryId,
      categories: defaultTabs.categories,
    }),
  );
  const output = lastFrame() ?? '';
  t.true(output.includes('agent.model'));
  t.true(output.includes('gpt-5'));
  t.true(output.includes('shell.timeout'));
});

test('SettingsSelectionMenu shows category headers', (t) => {
  const { lastFrame } = render(
    React.createElement(SettingsSelectionMenu, {
      items,
      selectedIndex: 0,
      query: '',
      activeCategoryId: defaultTabs.activeCategoryId,
      categories: defaultTabs.categories,
    }),
  );
  const output = lastFrame() ?? '';
  t.true(output.includes('Model & Reasoning'));
});

test('SettingsSelectionMenu marks the selected item', (t) => {
  const { lastFrame } = render(
    React.createElement(SettingsSelectionMenu, {
      items,
      selectedIndex: 1,
      query: '',
      activeCategoryId: defaultTabs.activeCategoryId,
      categories: defaultTabs.categories,
    }),
  );
  const output = lastFrame() ?? '';
  // We mark selected rows with a leading arrow
  t.true(output.includes('▶'));
  t.true(output.includes('shell.timeout'));
});
