import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import SettingsSelectionMenu from './SettingsSelectionMenu.js';
import type { SettingCompletionItem } from '../hooks/use-settings-completion.js';

const items: SettingCompletionItem[] = Array.from({ length: 12 }, (_, index) => ({
  key: `agent.setting${index}`,
  description: `Setting ${index}`,
  currentValue: index,
}));

test('SettingsSelectionMenu uses scrollOffset to control the visible window', (t) => {
  const { lastFrame } = render(
    React.createElement(SettingsSelectionMenu, {
      items,
      selectedIndex: 10,
      scrollOffset: 1,
      query: '',
      activeCategoryId: 'model',
      categories: [{ id: 'model', label: 'Model & Reasoning' }],
    }),
  );

  const output = lastFrame() ?? '';

  t.false(output.includes('agent.setting0'));
  t.true(output.includes('agent.setting1'));
  t.true(output.includes('agent.setting10'));
  t.false(output.includes('agent.setting11'));
});

test('SettingsSelectionMenu renders task tabs and switch hint', (t) => {
  const { lastFrame } = render(
    React.createElement(SettingsSelectionMenu, {
      items: [
        {
          key: 'agent.model',
          description: 'Model',
          currentValue: 'gpt-5',
        },
      ],
      selectedIndex: 0,
      scrollOffset: 0,
      query: '',
      activeCategoryId: 'model',
      categories: [
        { id: 'model', label: 'Model & Reasoning' },
        { id: 'shell', label: 'Shell Execution' },
      ],
    }),
  );

  const output = lastFrame() ?? '';

  t.true(output.includes('Model & Reasoning'));
  t.true(output.includes('Shell Execution'));
  t.true(output.includes('Tab/←→ → switch section'));
});
