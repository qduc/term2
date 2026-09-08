// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
global.IS_REACT_ACT_ENVIRONMENT = true;
import { expect, it } from 'vitest';
import React from 'react';
import { Box } from 'ink';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';
import type { SlashCommand } from '../../slash-commands.js';
import SlashCommandMenu from './SlashCommandMenu.js';

const commands: SlashCommand[] = [
  { name: 'clear', description: 'Start a new conversation', action: () => {} },
  {
    name: 'copy',
    description: 'Copy an assistant response (latest by default; use /copy N to count backward)',
    action: () => {},
  },
];

it.sequential('aligns wrapped descriptions with the description text', async () => {
  const { lastFrame } = await renderInAct(
    <Box width={60}>
      <SlashCommandMenu commands={commands} selectedIndex={-1} filter="" />
    </Box>,
  );

  const lines = toVisibleText(lastFrame()!).split('\n');
  const copyLine = lines.find((line) => line.includes('Copy an assistant'));
  const continuationLine = lines.find((line) => line.includes('default; use /copy'));

  expect(copyLine).toBeDefined();
  expect(continuationLine).toBeDefined();
  expect(copyLine).toContain('- Copy an assistant');
  expect(continuationLine!.indexOf('default; use /copy')).toBe(copyLine!.indexOf('Copy'));
});

const wrappingCommands: SlashCommand[] = [
  { name: 'clear', description: 'Start a new conversation', action: () => {} },
  {
    name: 'copy',
    description: 'Copy an assistant response (latest by default; use /copy N to count backward)',
    action: () => {},
  },
];

// Visible text with window chrome (borders, footers) and all whitespace
// removed, so a mid-word line wrap cannot break a containment check: what
// remains is exactly the content characters in reading order.
const compactVisible = (frame: string): string =>
  toVisibleText(frame)
    .replace(/[│╭╮╰╯─]/g, '')
    .replace(/\s+/g, '');
const compactWords = (s: string): string => s.replace(/\s+/g, '');

// Regression: fixed 14+3 label/separator columns squeezed the selection
// gutter to zero at 24 cols and wrapped the description into 2-character
// fragments with unbounded row height. The old test only rendered at 60
// cols with selectedIndex={-1}, so it never saw a marker at all.
for (const width of [80, 40, 24]) {
  it.sequential(`keeps a stable marker gutter and the full description at ${width} cols`, async () => {
    const { lastFrame } = await renderInAct(
      <Box width={width}>
        <SlashCommandMenu commands={wrappingCommands} selectedIndex={1} filter="" />
      </Box>,
    );

    const frame = toVisibleText(lastFrame()!);
    const lines = frame.split('\n');

    // The selected row keeps its two-cell gutter: `❯ /copy`, never `❯/copy`
    // or a bare `/copy`.
    const selectedLine = lines.find((line) => line.includes('/copy'));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toMatch(/❯ \/copy/);
    // Unselected rows keep a two-space gutter on the same left edge.
    const unselectedLine = lines.find((line) => line.includes('/clear'));
    expect(unselectedLine).toBeDefined();
    expect(unselectedLine).toMatch(/ {2}\/clear/);
    expect(unselectedLine).not.toContain('❯');

    // No characters are lost to wrapping: the whole description is present
    // in reading order, ignoring line breaks and window chrome.
    const compacted = compactVisible(frame);
    expect(compacted).toContain(
      compactWords('Copy an assistant response (latest by default; use /copy N to count backward)'),
    );
    expect(compacted).toContain(compactWords('Start a new conversation'));

    // No row fragments into per-character shards: every content line
    // carries real text (structural padding, rules, and hints excluded).
    for (const line of lines) {
      const content = line.replace(/[│╭╮╰╯]/g, '').trim();
      if (!content || /^─+$/.test(content)) continue;
      if (/^(↑↓|⏎|esc)/.test(content)) continue;
      expect(content.length).toBeGreaterThan(5);
    }

    // Nothing spills past the terminal edge.
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });
}

it.sequential('truncates an over-long command label instead of eating the row', async () => {
  const longName = 'a-command-name-that-far-exceeds-the-label-cap';
  const { lastFrame } = await renderInAct(
    <Box width={80}>
      <SlashCommandMenu
        commands={[{ name: longName, description: 'Does something useful', action: () => {} }]}
        selectedIndex={0}
        filter=""
      />
    </Box>,
  );

  const frame = toVisibleText(lastFrame()!);
  const normalized = frame.replace(/\s+/g, ' ');
  const compacted = compactVisible(frame);
  // The label is cut, but the marker and the description survive intact.
  expect(compacted).not.toContain(longName);
  expect(normalized).toMatch(/❯ \/a-command-name/);
  expect(compacted).toContain(compactWords('Does something useful'));
});
