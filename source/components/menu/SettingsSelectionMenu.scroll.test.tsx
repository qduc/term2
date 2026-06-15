// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React from 'react';
import { renderInAct, rerenderInAct } from '../../test-helpers/ink-testing.js';
import SettingsSelectionMenu from './SettingsSelectionMenu.js';
import type { SettingCompletionItem } from '../../hooks/use-settings-completion.js';

const items: SettingCompletionItem[] = Array.from({ length: 12 }, (_, index) => ({
  key: `agent.setting${index}`,
  description: `Setting ${index}`,
  currentValue: index,
}));

test.serial('SettingsSelectionMenu uses scrollOffset to control the visible window', async (t) => {
  const { lastFrame } = await renderInAct(
    <SettingsSelectionMenu
      items={items}
      selectedIndex={10}
      scrollOffset={1}
      query=""
      activeCategoryId="model"
      categories={[{ id: 'model', label: 'Model & Reasoning' }]}
    />,
    t,
  );

  const output = lastFrame() ?? '';

  t.false(output.includes('agent.setting0'));
  t.true(output.includes('agent.setting1'));
  t.true(output.includes('agent.setting10'));
  t.false(output.includes('agent.setting11'));
});

test.serial('SettingsSelectionMenu renders task tabs and switch hint', async (t) => {
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
    t,
  );

  const output = lastFrame() ?? '';

  t.true(output.includes('Model & Reasoning'));
  t.true(output.includes('Shell Execution'));
  t.true(output.includes('Tab/←→ → switch section'));
});

test.serial('SettingsSelectionMenu keeps task tabs on one row', async (t) => {
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
    t,
  );

  const lines = (lastFrame() ?? '').split('\n');
  t.true(lines[0]?.includes('Tab/←→ → switch section'));
  t.false(lines[0]?.includes('STab/←→ → switch section'));
  t.true(lines[1]?.startsWith('╭'));
});

test.serial('SettingsSelectionMenu shrinks after broad search collapses', async (t) => {
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
    t,
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

  t.true(collapsedHeight < expandedHeight);
  t.true(switchedHeight < expandedHeight);
});
