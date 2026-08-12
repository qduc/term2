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
