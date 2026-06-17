// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import UndoSelectionMenu from './UndoSelectionMenu.js';
import type { UndoItem } from '../../hooks/use-undo-selection.js';

const makeItem = (uiIndex: number, text: string): UndoItem => ({ uiIndex, text });

it.sequential('UndoSelectionMenu renders empty state', async () => {
  const { lastFrame } = await renderInAct(<UndoSelectionMenu items={[]} selectedIndex={0} />);
  const output = lastFrame() ?? '';
  expect(output.includes('No messages to undo')).toBe(true);
});

it.sequential('UndoSelectionMenu renders list of items', async () => {
  const items: UndoItem[] = [
    makeItem(0, 'Hello'),
    makeItem(2, 'How are you?'),
    makeItem(4, 'Can you help me with this task?'),
  ];
  const { lastFrame } = await renderInAct(<UndoSelectionMenu items={items} selectedIndex={1} />);
  const output = lastFrame() ?? '';
  expect(output.includes('Hello')).toBe(true);
  expect(output.includes('How are you?')).toBe(true);
  expect(output.includes('Can you help me')).toBe(true);
  expect(output.includes('Enter')).toBe(true);
  expect(output.includes('Esc')).toBe(true);
});

it.sequential('UndoSelectionMenu truncates long messages', async () => {
  const longText = 'A'.repeat(100);
  const items: UndoItem[] = [makeItem(0, longText)];
  const { lastFrame } = await renderInAct(<UndoSelectionMenu items={items} selectedIndex={0} />);
  const output = lastFrame() ?? '';
  // The message should be truncated, not showing all 100 A's
  expect(output.includes('A'.repeat(60))).toBe(false);
});
