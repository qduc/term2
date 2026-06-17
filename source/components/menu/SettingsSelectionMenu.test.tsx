// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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

it.sequential('SettingsSelectionMenu renders empty state (does not disappear)', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsSelectionMenu
      items={[]}
      selectedIndex={0}
      query="abc"
      activeCategoryId={defaultTabs.activeCategoryId}
      categories={defaultTabs.categories}
    />,
  );
  expect(lastFrame()?.includes('No settings match')).toBe(true);
  expect(lastFrame()?.includes('abc')).toBe(true);
});

it.sequential('SettingsSelectionMenu renders settings list and their current values', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsSelectionMenu
      items={items}
      selectedIndex={0}
      query="ag"
      isSearchingAll={true}
      activeCategoryId={defaultTabs.activeCategoryId}
      categories={defaultTabs.categories}
    />,
  );
  const output = lastFrame() ?? '';
  expect(output.includes('agent.model')).toBe(true);
  expect(output.includes('gpt-5')).toBe(true);
  expect(output.includes('shell.timeout')).toBe(true);
});

it.sequential('SettingsSelectionMenu shows category headers', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsSelectionMenu
      items={items}
      selectedIndex={0}
      query=""
      activeCategoryId={defaultTabs.activeCategoryId}
      categories={defaultTabs.categories}
    />,
  );
  const output = lastFrame() ?? '';
  expect(output.includes('Model & Reasoning')).toBe(true);
});

it.sequential('SettingsSelectionMenu marks the selected item', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsSelectionMenu
      items={items}
      selectedIndex={1}
      query=""
      activeCategoryId={defaultTabs.activeCategoryId}
      categories={defaultTabs.categories}
    />,
  );
  const output = lastFrame() ?? '';
  // We mark selected rows with a leading arrow
  expect(output.includes('▶')).toBe(true);
  expect(output.includes('shell.timeout')).toBe(true);
});
