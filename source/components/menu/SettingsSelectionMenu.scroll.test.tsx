// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React from 'react';
import { renderInAct, rerenderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';
import SettingsSelectionMenu from './SettingsSelectionMenu.js';
import type { SettingCompletionItem } from '../../hooks/use-settings-completion.js';

const items: SettingCompletionItem[] = Array.from({ length: 12 }, (_, index) => ({
  key: `agent.setting${index}`,
  description: `Setting ${index}`,
  currentValue: index,
}));

it.sequential('SettingsSelectionMenu uses scrollOffset to control the visible window', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsSelectionMenu
      items={items}
      selectedIndex={10}
      scrollOffset={1}
      query=""
      activeCategoryId="model"
      categories={[{ id: 'model', label: 'Model & Reasoning' }]}
    />,
  );

  const output = lastFrame() ?? '';

  expect(output.includes('agent.setting0')).toBe(false);
  expect(output.includes('agent.setting1')).toBe(true);
  expect(output.includes('agent.setting10')).toBe(true);
  expect(output.includes('agent.setting11')).toBe(false);
});

it.sequential('SettingsSelectionMenu renders task tabs and switch hint', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsSelectionMenu
      items={[
        {
          key: 'agent.model',
          description: 'Model',
          currentValue: 'gpt-5',
        },
      ]}
      selectedIndex={0}
      scrollOffset={0}
      query=""
      activeCategoryId="model"
      categories={[
        { id: 'model', label: 'Model & Reasoning' },
        { id: 'shell', label: 'Shell Execution' },
      ]}
    />,
  );

  const output = lastFrame() ?? '';

  expect(output.includes('Model & Reasoning')).toBe(true);
  expect(output.includes('Shell Execution')).toBe(true);
  expect(output.includes('Tab/←→ → switch section')).toBe(true);
});

it.sequential('SettingsSelectionMenu keeps task tabs on one row', async () => {
  const { lastFrame } = await renderInAct(
    <SettingsSelectionMenu
      items={[
        {
          key: 'app.orchestratorMode',
          description: 'Delegate tool-backed work through subagents (true|false)',
          currentValue: true,
        },
        {
          key: 'app.planMode',
          description: 'Plan mode: read-only research and implementation planning (true|false)',
          currentValue: false,
        },
      ]}
      selectedIndex={0}
      scrollOffset={0}
      query=""
      activeCategoryId="modes"
      categories={[
        { id: 'model', label: 'Model & Reasoning' },
        { id: 'modes', label: 'Modes' },
        { id: 'approvals', label: 'Safety & Approvals' },
        { id: 'shell', label: 'Shell Execution' },
        { id: 'search', label: 'Search & Web' },
        { id: 'subagents', label: 'Subagents' },
        { id: 'uiLogging', label: 'UI & Logging' },
        { id: 'advanced', label: 'Advanced' },
      ]}
    />,
  );

  const lines = toVisibleText(lastFrame() ?? '').split('\n');
  expect(lines[0]?.includes('Tab/←→ → switch section')).toBe(true);
  expect(lines[0]?.includes('STab/←→ → switch section')).toBe(false);
  expect(lines[1]?.startsWith('╭')).toBe(true);
});

it.sequential('SettingsSelectionMenu shrinks after broad search collapses', async () => {
  const categories = [
    { id: 'model', label: 'Model & Reasoning' },
    { id: 'modes', label: 'Modes' },
    { id: 'approvals', label: 'Safety & Approvals' },
    { id: 'shell', label: 'Shell Execution' },
    { id: 'search', label: 'Search & Web' },
    { id: 'subagents', label: 'Subagents' },
    { id: 'uiLogging', label: 'UI & Logging' },
    { id: 'advanced', label: 'Advanced' },
  ];
  const searchItems = [
    'agent.model',
    'app.planMode',
    'agent.maxTurns',
    'agent.temperature',
    'agent.mentorModel',
    'app.searchViaShell',
    'agent.retryAttempts',
    'app.orchestratorMode',
    'agent.reasoningEffort',
    'agent.autoApproveModel',
  ].map((key) => ({
    key,
    description: `Description for ${key}`,
    currentValue: key.startsWith('app.') ? false : 'value',
  }));
  const modeItems = [
    {
      key: 'app.orchestratorMode',
      description: 'Delegate tool-backed work through subagents (true|false)',
      currentValue: true,
    },
    {
      key: 'app.planMode',
      description: 'Plan mode: read-only research and implementation planning (true|false)',
      currentValue: false,
    },
  ];

  const view = await renderInAct(
    <SettingsSelectionMenu
      items={searchItems}
      selectedIndex={0}
      scrollOffset={0}
      query="a"
      isSearchingAll={true}
      activeCategoryId="modes"
      categories={categories}
    />,
  );
  const expandedHeight = (view.lastFrame() ?? '').split('\n').length;

  await rerenderInAct(
    view,
    <SettingsSelectionMenu
      items={modeItems}
      selectedIndex={0}
      scrollOffset={0}
      query=""
      activeCategoryId="modes"
      categories={categories}
    />,
  );
  const collapsedHeight = (view.lastFrame() ?? '').split('\n').length;

  await rerenderInAct(
    view,
    <SettingsSelectionMenu
      items={[
        {
          key: 'shell.timeout',
          description: 'Shell command timeout in milliseconds',
          currentValue: 120000,
        },
        {
          key: 'shell.maxOutputLines',
          description: 'Maximum lines of shell output to capture',
          currentValue: 1000,
        },
      ]}
      selectedIndex={0}
      scrollOffset={0}
      query=""
      activeCategoryId="shell"
      categories={categories}
    />,
  );
  const switchedHeight = (view.lastFrame() ?? '').split('\n').length;

  expect(collapsedHeight < expandedHeight).toBe(true);
  expect(switchedHeight < expandedHeight).toBe(true);
});
