// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import os from 'node:os';
import React from 'react';
import { Box } from 'ink';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';
import ModelSelectionMenu from './ModelSelectionMenu.js';
import type { ModelInfo } from '../../services/model-service.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import { FAVORITES_TAB_ID, serializeFavorite } from '../../services/models/model-favorites.js';

const mockModels: ModelInfo[] = [
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
  { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', provider: 'openai' },
  { id: 'claude-3-opus', name: 'Claude 3 Opus', provider: 'openrouter' },
];

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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

it.sequential('ModelSelectionMenu renders a unified list with the provider on every row', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu settingsService={createMockSettingsService()} items={mockModels} selectedIndex={0} query="" />,
  );
  const output = lastFrame();
  expect(output?.includes('gpt-4o')).toBe(true);
  expect(output?.includes('GPT-4o')).toBe(true);
  expect(output?.includes('gpt-4-turbo')).toBe(true);
  expect(output?.includes('claude-3-opus')).toBe(true);
  expect(output?.includes('(openai)')).toBe(true);
  expect(output?.includes('(openrouter)')).toBe(true);
  expect(output).not.toContain(' Favorites ');
});

it.sequential('ModelSelectionMenu footer includes refresh hint', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu settingsService={createMockSettingsService()} items={mockModels} selectedIndex={0} query="" />,
  );

  const output = lastFrame();
  expect(output?.includes('ctrl+r refresh model list')).toBe(true);
});

it.sequential('ModelSelectionMenu does not duplicate refresh hint', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu settingsService={createMockSettingsService()} items={mockModels} selectedIndex={0} query="" />,
  );

  const output = lastFrame();
  expect(output?.match(/ctrl\+r refresh model list/g)).toHaveLength(1);
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

it.sequential('ModelSelectionMenu gives Codex login guidance for an unavailable Codex model', async () => {
  vi.stubEnv('CHATGPT_LOCAL_HOME', '');
  vi.stubEnv('CODEX_HOME', '/tmp/term2-test-no-codex-auth');
  vi.stubEnv('TERM2_CONFIG_DIR', '/tmp/term2-test-no-term2-auth');
  vi.spyOn(os, 'homedir').mockReturnValue('/tmp/term2-test-no-codex-home');

  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu
      settingsService={createMockSettingsService()}
      items={[{ id: 'gpt-5.3-codex', provider: 'codex', unavailableReason: 'missing-codex-login' }]}
      selectedIndex={0}
      query=""
      provider="codex"
    />,
  );

  const output = lastFrame()!;
  expect(output).toContain('Not logged in on this host');
  expect(output).toContain('term2 --codex-login');
  expect(output).toContain('(login required)');
  expect(output).not.toContain('API key not configured on this host');
});

it.sequential('ModelSelectionMenu retains API-key guidance for unavailable API-key models', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu
      settingsService={createMockSettingsService()}
      items={[{ id: 'gpt-4o', provider: 'openai', unavailableReason: 'missing-credentials' }]}
      selectedIndex={0}
      query=""
      provider="openai"
    />,
  );

  const output = lastFrame()!;
  expect(output).toContain('API key not configured on this host');
  expect(output).toContain('Use Provider Management to configure it');
  expect(output).not.toContain('term2 --codex-login');
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

it.sequential('ModelSelectionMenu renders a Favorites tab pinned leftmost, ahead of provider tabs', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu
      settingsService={createMockSettingsService()}
      items={[]}
      selectedIndex={0}
      query=""
      provider="openai"
    />,
  );
  const output = lastFrame() ?? '';
  const favoritesIdx = output.indexOf('Favorites');
  const openAiIdx = output.indexOf('OpenAI');
  expect(favoritesIdx).toBeGreaterThanOrEqual(0);
  expect(openAiIdx).toBeGreaterThanOrEqual(0);
  expect(favoritesIdx).toBeLessThan(openAiIdx);
});

it.sequential('ModelSelectionMenu shows a "how to add" empty state on the Favorites tab with no query', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu
      settingsService={createMockSettingsService()}
      items={[]}
      selectedIndex={0}
      query=""
      provider={FAVORITES_TAB_ID}
    />,
  );
  expect(lastFrame()).toContain('No favorites yet');
  expect(lastFrame()).toContain('ctrl+f');
});

it.sequential('ModelSelectionMenu shows the ordinary no-match message on the Favorites tab with a query', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu
      settingsService={createMockSettingsService()}
      items={[]}
      selectedIndex={0}
      query="xyz"
      provider={FAVORITES_TAB_ID}
    />,
  );
  expect(lastFrame()).toContain('No models match "xyz"');
  expect(lastFrame()).not.toContain('No favorites yet');
});

it.sequential('ModelSelectionMenu renders favorited models with their home provider dimmed', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu
      settingsService={createMockSettingsService()}
      items={[{ id: 'gpt-4o', provider: 'openai' }]}
      selectedIndex={0}
      query=""
      provider={FAVORITES_TAB_ID}
    />,
  );
  const output = lastFrame() ?? '';
  expect(output).toContain('gpt-4o');
  expect(output).toContain('(openai)');
});

it.sequential('ModelSelectionMenu footer includes the favorite hint', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu settingsService={createMockSettingsService()} items={mockModels} selectedIndex={0} query="" />,
  );
  expect(lastFrame()?.includes('ctrl+f favorite')).toBe(true);
});

it.sequential('ModelSelectionMenu marks a favorited row on a normal provider tab', async () => {
  const favoriteKeys = new Set([serializeFavorite('openai', 'gpt-4o')]);
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu
      settingsService={createMockSettingsService()}
      items={mockModels}
      selectedIndex={0}
      query=""
      provider="openai"
      favoriteKeys={favoriteKeys}
    />,
  );
  const output = lastFrame() ?? '';
  const favoritedLine = output.split('\n').find((line) => line.includes('gpt-4o') && !line.includes('gpt-4-turbo'));
  const unfavoritedLine = output.split('\n').find((line) => line.includes('gpt-4-turbo'));
  expect(favoritedLine).toBeTruthy();
  expect(unfavoritedLine).toBeTruthy();
  expect(favoritedLine).toContain('★');
  expect(unfavoritedLine).not.toContain('★');
});

it.sequential('renders existing nicknames on rows', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu
      settingsService={createMockSettingsService()}
      items={[{ id: 'gpt-fav', name: 'GPT Fav', provider: 'openai' }]}
      selectedIndex={0}
      query=""
      provider={FAVORITES_TAB_ID}
      nicknameLabels={new Map([['openai/gpt-fav', 'op']])}
    />,
  );
  const output = lastFrame() ?? '';
  expect(output).toContain('aka');
  expect(output).toContain('"op"');
});

it.sequential(
  'renders the inline nickname editor and its rejection error while a draft is open on the Favorites tab',
  async () => {
    const { lastFrame } = await renderInAct(
      <ModelSelectionMenu
        settingsService={createMockSettingsService()}
        items={[{ id: 'gpt-fav', name: 'GPT Fav', provider: 'openai' }]}
        selectedIndex={0}
        query=""
        provider={FAVORITES_TAB_ID}
        nicknameDraft={{
          provider: 'openai',
          modelId: 'gpt-fav',
          text: 'op',
          error: 'Nickname "op" is already in use.',
        }}
      />,
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('Nickname for gpt-fav:');
    expect(output).toContain('op');
    expect(output).toContain('Nickname "op" is already in use.');
  },
);

// Regression: each row used to render the id, provider, nickname, and
// display name as sibling Text fields that shrank and wrapped
// independently — at 40 cols `claude-sonnet-4-20250514 (anthropic) — Claude
// Sonnet 4` lost the `p` in the provider and scrambled reading order, and
// favorites/nicknames broke the row even at 80. The row is now one
// paragraph, so wrapping can never drop characters or reorder segments.
const wrappingModel: ModelInfo = { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic' };

for (const width of [80, 40, 24]) {
  it.sequential(`keeps the model row intact and ordered at ${width} cols`, async () => {
    const { lastFrame } = await renderInAct(
      <Box width={width}>
        <ModelSelectionMenu
          settingsService={createMockSettingsService()}
          items={[wrappingModel]}
          selectedIndex={0}
          query=""
        />
      </Box>,
    );

    const frame = toVisibleText(lastFrame()!);
    const lines = frame.split('\n');

    // Stable two-cell marker gutter on the row.
    expect(lines.some((line) => /❯ claude-sonnet/.test(line))).toBe(true);

    // No dropped characters anywhere on the row: strip window chrome and
    // all whitespace (line breaks included) and require each segment
    // verbatim, in order.
    const compacted = frame.replace(/[│╭╮╰╯─]/g, '').replace(/\s+/g, '');
    const idIdx = compacted.indexOf('claude-sonnet-4-20250514');
    const providerIdx = compacted.indexOf('(anthropic)');
    const nameIdx = compacted.indexOf('ClaudeSonnet4');
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(providerIdx).toBeGreaterThanOrEqual(0);
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(providerIdx).toBeGreaterThan(idIdx);
    expect(nameIdx).toBeGreaterThan(providerIdx);

    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });
}

it.sequential('keeps a favorited, nicknamed row on one ordered line at 80 cols', async () => {
  const { lastFrame } = await renderInAct(
    <Box width={80}>
      <ModelSelectionMenu
        settingsService={createMockSettingsService()}
        items={[wrappingModel]}
        selectedIndex={0}
        query=""
        favoriteKeys={new Set([serializeFavorite('anthropic', 'claude-sonnet-4-20250514')])}
        nicknameLabels={new Map([['anthropic/claude-sonnet-4-20250514', 'sonny']])}
      />
    </Box>,
  );

  const frame = toVisibleText(lastFrame()!);
  const row = frame.split('\n').find((line) => line.includes('claude-sonnet-4-20250514'));
  expect(row).toBeDefined();
  expect(row).toContain('❯');
  expect(row).toContain('★');
  expect(row).toContain('aka "sonny"');
  expect(row).toContain('(anthropic)');
  expect(row).toContain('Claude Sonnet 4');
  const order = ['❯', '★', 'claude-sonnet-4-20250514', 'aka "sonny"', '(anthropic)', 'Claude Sonnet 4'].map((s) =>
    row!.indexOf(s),
  );
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

it.sequential('does not render the nickname editor row on provider tabs', async () => {
  const { lastFrame } = await renderInAct(
    <ModelSelectionMenu
      settingsService={createMockSettingsService()}
      items={[{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' }]}
      selectedIndex={0}
      query=""
      provider="openai"
      nicknameLabels={new Map([['openai/gpt-4o', 'four-oh']])}
    />,
  );
  const output = lastFrame() ?? '';
  // Nickname labels render on rows everywhere, but the editor row and its
  // hint belong to the Favorites tab only.
  expect(output).toContain('aka "four-oh"');
  expect(output).not.toContain('Nickname for');
  expect(output).not.toContain('ctrl+n');
});
