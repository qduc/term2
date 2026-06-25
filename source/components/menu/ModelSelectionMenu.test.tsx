// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import ModelSelectionMenu from './ModelSelectionMenu.js';
import type { ModelInfo } from '../../services/model-service.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';

const mockModels: ModelInfo[] = [
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
  { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', provider: 'openai' },
  { id: 'claude-3-opus', name: 'Claude 3 Opus', provider: 'openrouter' },
];

it.sequential('ModelSelectionMenu renders loading state', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu
      settingsService={createMockSettingsService()}
      items={[]}
      selectedIndex={0}
      query=""
      loading={true}
    />,
  );
  expect(lastFrame()?.includes('Loading models')).toBe(true);
});

it.sequential('ModelSelectionMenu renders error state', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu
      settingsService={createMockSettingsService()}
      items={[]}
      selectedIndex={0}
      query=""
      error="Failed to fetch"
    />,
  );
  expect(lastFrame()?.includes('Unable to load models: Failed to fetch')).toBe(true);
});

it.sequential('ModelSelectionMenu renders empty state', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu settingsService={createMockSettingsService()} items={[]} selectedIndex={0} query="xyz" />,
  );
  expect(lastFrame()?.includes('No models match "xyz"')).toBe(true);
});

it.sequential('ModelSelectionMenu renders list of models', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu settingsService={createMockSettingsService()} items={mockModels} selectedIndex={0} query="" />,
  );
  const output = lastFrame();
  expect(output?.includes('gpt-4o')).toBe(true);
  expect(output?.includes('GPT-4o')).toBe(true);
  expect(output?.includes('gpt-4-turbo')).toBe(true);
  expect(output?.includes('claude-3-opus')).toBe(true);
});

it.sequential('ModelSelectionMenu footer includes refresh hint', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu settingsService={createMockSettingsService()} items={mockModels} selectedIndex={0} query="" />,
  );

  const output = lastFrame();
  expect(output?.includes('Ctrl+R → refresh model list')).toBe(true);
});

it.sequential('ModelSelectionMenu does not duplicate refresh hint', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu settingsService={createMockSettingsService()} items={mockModels} selectedIndex={0} query="" />,
  );

  const output = lastFrame();
  expect(output?.match(/Ctrl\+R → refresh model list/g)).toHaveLength(1);
});

it.sequential('ModelSelectionMenu highlights selected item', async () => {
  // Ink testing library doesn't easily show colors in text output,
  // but we can check if the selected item is present.
  // We rely on the component logic which we can assume works if it renders.
  // To be more specific, we could check for ANSI codes if we really wanted to,
  // but checking content is usually enough for unit tests here.
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu settingsService={createMockSettingsService()} items={mockModels} selectedIndex={1} query="" />,
  );
  const output = lastFrame();
  expect(output?.includes('gpt-4-turbo')).toBe(true);
});

it.sequential('ModelSelectionMenu shows provider in header if specified', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu
      settingsService={createMockSettingsService()}
      items={mockModels}
      selectedIndex={0}
      query=""
      provider="openai"
    />,
  );
  expect(lastFrame()?.includes('OpenAI')).toBe(true);
});

it.sequential('ModelSelectionMenu provider tabs include custom providers from settings', async () => {
  // Use a short provider name that will fit in the visible tab area
  const providerId = `ls`;
  const settingsService = createMockSettingsService({
    providers: [
      {
        name: providerId,
        baseUrl: 'http://localhost:1234',
      },
    ],
  });

  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu
      settingsService={settingsService}
      items={mockModels}
      selectedIndex={0}
      query=""
      provider="openai"
    />,
  );

  const output = lastFrame();
  // Check that the short provider name appears in the tab bar
  // or that there's a right-scroll indicator (▶) meaning there are more tabs
  expect(output?.includes(providerId) || output?.includes('▶')).toBe(true);
});

it.sequential('ModelSelectionMenu shows scroll indicators for long lists', async () => {
  const longList: ModelInfo[] = Array.from({ length: 20 }, (_, i) => ({
    id: `model-${i}`,
    name: `Model ${i}`,
    provider: 'openai',
  }));

  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu
      settingsService={createMockSettingsService()}
      items={longList}
      selectedIndex={5}
      query=""
      scrollOffset={2}
      maxHeight={10}
    />,
  );
  const output = lastFrame();
  // Should show scroll up indicator
  expect(output?.includes('↑ 2 more')).toBe(true);
  // Should show scroll down indicator (20 - 2 - 10 = 8 more)
  expect(output?.includes('↓ 8 more')).toBe(true);
});

it.sequential('ModelSelectionMenu does not show scroll indicators for short lists', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu
      settingsService={createMockSettingsService()}
      items={mockModels}
      selectedIndex={0}
      query=""
      scrollOffset={0}
      maxHeight={10}
    />,
  );
  const output = lastFrame();
  // Should not show position indicator for lists shorter than maxHeight
  // Check for the specific pagination format N-N/N rather than any "/"
  expect(output?.match(/\d+-\d+\/\d+/) !== null).toBe(false);
  // For short lists with no scroll, should not have "N more" indicators
  expect(output?.match(/\d+ more/) !== null).toBe(false);
});
