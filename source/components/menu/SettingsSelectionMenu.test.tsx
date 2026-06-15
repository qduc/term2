// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
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

test.serial('SettingsSelectionMenu renders empty state (does not disappear)', async (t) => {
  const { lastFrame } = await renderInAct(
    <SettingsSelectionMenu
      items={[]}
      selectedIndex={0}
      query="abc"
      activeCategoryId={defaultTabs.activeCategoryId}
      categories={defaultTabs.categories}
    />,
    t,
  );
  t.true(lastFrame()?.includes('No settings match'));
  t.true(lastFrame()?.includes('abc'));
});

test.serial('SettingsSelectionMenu renders settings list and their current values', async (t) => {
  const { lastFrame } = await renderInAct(
    <SettingsSelectionMenu
      items={items}
      selectedIndex={0}
      query="ag"
      isSearchingAll={true}
      activeCategoryId={defaultTabs.activeCategoryId}
      categories={defaultTabs.categories}
    />,
    t,
  );
  const output = lastFrame() ?? '';
  t.true(output.includes('agent.model'));
  t.true(output.includes('gpt-5'));
  t.true(output.includes('shell.timeout'));
});

test.serial('SettingsSelectionMenu shows category headers', async (t) => {
  const { lastFrame } = await renderInAct(
    <SettingsSelectionMenu
      items={items}
      selectedIndex={0}
      query=""
      activeCategoryId={defaultTabs.activeCategoryId}
      categories={defaultTabs.categories}
    />,
    t,
  );
  const output = lastFrame() ?? '';
  t.true(output.includes('Model & Reasoning'));
});

test.serial('SettingsSelectionMenu marks the selected item', async (t) => {
  const { lastFrame } = await renderInAct(
    <SettingsSelectionMenu
      items={items}
      selectedIndex={1}
      query=""
      activeCategoryId={defaultTabs.activeCategoryId}
      categories={defaultTabs.categories}
    />,
    t,
  );
  const output = lastFrame() ?? '';
  // We mark selected rows with a leading arrow
  t.true(output.includes('▶'));
  t.true(output.includes('shell.timeout'));
});
