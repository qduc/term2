// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
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
  expect(output.includes('2m')).toBe(true);
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
  // Rows carry ANSI styling around the gutter marker, so strip it and check
  // which row actually holds the arrow (shell.timeout is selectedIndex 1).
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  const markedRows = plain.split('\n').filter((line) => line.includes('▶'));
  expect(markedRows).toHaveLength(1);
  expect(markedRows[0]).toContain('shell.timeout');
  expect(markedRows[0]).not.toContain('agent.model');
  const unmarkedRow = plain.split('\n').find((line) => line.includes('agent.model')) ?? '';
  expect(unmarkedRow.includes('▶')).toBe(false);
});

it.sequential('SettingsSelectionMenu displays highlighted item description at the bottom footer', async () => {
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
  expect(output.includes('The AI model to use')).toBe(true);
  expect(output.includes('└──')).toBe(false);
});

it.sequential('SettingsSelectionMenu updates bottom description when selectedIndex changes', async () => {
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
  expect(output.includes('Shell command timeout in milliseconds')).toBe(true);
  expect(output.includes('The AI model to use')).toBe(false);
  expect(output.includes('└──')).toBe(false);
});

it.sequential(
  'SettingsSelectionMenu formats durations, currencies, percentages, and collections in human-friendly format',
  async () => {
    const customItems: SettingCompletionItem[] = [
      {
        key: 'agent.runBudget.maxUsdMicros',
        currentValue: 5000000,
      },
      {
        key: 'agent.runBudget.maxActiveTimeMs',
        currentValue: 3600000,
      },
      {
        key: 'agent.contextCompaction.compactThreshold',
        currentValue: 0.8,
      },
      {
        key: 'agent.sessionRollover.milestones',
        currentValue: [200000, 300000, 400000],
      },
      {
        key: 'agent.smartModel',
        currentValue: undefined,
      },
    ];

    const { lastFrame } = await renderInAct(
      <SettingsSelectionMenu
        items={customItems}
        selectedIndex={0}
        query=""
        activeCategoryId={defaultTabs.activeCategoryId}
        categories={defaultTabs.categories}
      />,
    );
    const output = lastFrame() ?? '';
    expect(output.includes('$5.00')).toBe(true);
    expect(output.includes('1h')).toBe(true);
    expect(output.includes('80%')).toBe(true);
    expect(output.includes('200k, 300k, 400k')).toBe(true);
    expect(output.includes('(inherits agent.model)')).toBe(true);
  },
);
