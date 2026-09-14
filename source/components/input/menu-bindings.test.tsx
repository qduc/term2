// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { expect, it } from 'vitest';
import React from 'react';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import type { SlashCommand } from '../../slash-commands.js';
import type { ModelInfo } from '../../services/model-service.js';
import SlashCommandMenu from '../menu/SlashCommandMenu.js';
import ModelSelectionMenu from '../menu/ModelSelectionMenu.js';
import {
  MENU_COMMAND_VOCABULARY,
  SLASH_MENU_BINDINGS,
  MODEL_MENU_BINDINGS,
  MODEL_MENU_PROVIDER_TAB_BINDINGS,
  MODEL_MENU_NICKNAME_DRAFT_BINDINGS,
  MODEL_MENU_PROVIDER_FALLBACK_BINDINGS,
  bindingHints,
} from './menu-bindings.js';

// The list footer renders only when the list has rows (MenuContainer
// frame behavior), so footer assertions use a non-empty fixture.
const mockModels: ModelInfo[] = [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' }];

const slashCommands: SlashCommand[] = [
  { name: 'clear', description: 'Start a new conversation', action: () => {} },
  { name: 'copy', description: 'Copy an assistant response', action: () => {} },
];

it.sequential('every declared command id belongs to the known event vocabulary', () => {
  const tables = [
    SLASH_MENU_BINDINGS,
    MODEL_MENU_BINDINGS,
    MODEL_MENU_PROVIDER_TAB_BINDINGS,
    MODEL_MENU_NICKNAME_DRAFT_BINDINGS,
    MODEL_MENU_PROVIDER_FALLBACK_BINDINGS,
  ];
  for (const table of tables) {
    for (const binding of table) {
      for (const command of binding.commands ?? []) {
        expect(
          (MENU_COMMAND_VOCABULARY as readonly string[]).includes(command),
          `command "${command}" on binding "${binding.key}" is not in MENU_COMMAND_VOCABULARY`,
        ).toBe(true);
      }
    }
  }
});

it.sequential('a Tab binding must record the standing decision that gives it its meaning', () => {
  const tables = [
    ['SLASH_MENU_BINDINGS', SLASH_MENU_BINDINGS],
    ['MODEL_MENU_BINDINGS', MODEL_MENU_BINDINGS],
  ] as const;
  for (const [name, table] of tables) {
    const tabBindings = table.filter((b) => b.commands?.includes('tab'));
    expect(tabBindings.length, `${name} should declare a Tab binding`).toBeGreaterThan(0);
    for (const binding of tabBindings) {
      expect(binding.rationale, `${name}'s "${binding.key}" Tab binding needs a recorded rationale`).toBeTruthy();
    }
  }
});

it.sequential('bindingHints strips commands and rationale and preserves order', () => {
  expect(bindingHints(MODEL_MENU_PROVIDER_TAB_BINDINGS)).toEqual([['←→', 'provider']]);
  expect(bindingHints(SLASH_MENU_BINDINGS).map(([key]) => key)).toEqual(['↑↓', '⏎', 'Tab', 'esc']);
});

it.sequential('SlashCommandMenu footer renders exactly the declared slash bindings', async () => {
  const { lastFrame } = await renderInAct(<SlashCommandMenu commands={slashCommands} selectedIndex={0} filter="" />);
  const output = toVisibleText(lastFrame()!);
  for (const [key, action] of bindingHints(SLASH_MENU_BINDINGS)) {
    expect(output).toContain(`${key} ${action}`);
  }
  // The previously unadvertised Tab-completion binding is now declared data.
  expect(output).toContain('Tab complete');
});

it.sequential('ModelSelectionMenu renders the declared unified bindings including the Tab ruling', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu
      settingsService={createMockSettingsService()}
      items={mockModels}
      selectedIndex={0}
      query=""
      modelTab="all"
    />,
  );
  const output = toVisibleText(lastFrame()!);
  for (const [key, action] of bindingHints(MODEL_MENU_BINDINGS)) {
    expect(output).toContain(`${key} ${action}`);
  }
});

it.sequential('ModelSelectionMenu swaps to the draft bindings while a nickname draft is open', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu
      settingsService={createMockSettingsService()}
      items={mockModels}
      selectedIndex={0}
      query=""
      modelTab="all"
      nicknameDraft={{ provider: 'openai', modelId: 'gpt-4o', text: 'four', error: null }}
    />,
  );
  const output = toVisibleText(lastFrame()!);
  for (const [key, action] of bindingHints(MODEL_MENU_NICKNAME_DRAFT_BINDINGS)) {
    expect(output).toContain(`${key} ${action}`);
  }
  // While the draft editor owns the input row, list bindings are suspended
  // and must not be advertised.
  expect(output).not.toContain('Tab/←→ tab');
  expect(output).not.toContain('ctrl+n nickname');
});

it.sequential(
  'ModelSelectionMenu renders the declared provider fallback bindings on a legacy error state',
  async () => {
    const { lastFrame } = await renderInAct(
      <ModelSelectionMenu
        settingsService={createMockSettingsService()}
        items={[]}
        selectedIndex={0}
        query=""
        provider="openai"
        error="Failed to fetch"
      />,
    );
    const output = toVisibleText(lastFrame()!);
    for (const [key, action] of bindingHints(MODEL_MENU_PROVIDER_FALLBACK_BINDINGS)) {
      expect(output).toContain(`${key} ${action}`);
    }
  },
);
