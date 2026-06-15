// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import UndoSelectionMenu from './UndoSelectionMenu.js';
import type { UndoItem } from '../../hooks/use-undo-selection.js';

const makeItem = (uiIndex: number, text: string): UndoItem => ({ uiIndex, text });

test.serial('UndoSelectionMenu renders empty state', async (t) => {
  const { lastFrame } = await renderInAct(<UndoSelectionMenu items={[]} selectedIndex={0} />, t);
  const output = lastFrame() ?? '';
  t.true(output.includes('No messages to undo'));
});

test.serial('UndoSelectionMenu renders list of items', async (t) => {
  const items: UndoItem[] = [
    makeItem(0, 'Hello'),
    makeItem(2, 'How are you?'),
    makeItem(4, 'Can you help me with this task?'),
  ];
  const { lastFrame } = await renderInAct(<UndoSelectionMenu items={items} selectedIndex={1} />, t);
  const output = lastFrame() ?? '';
  t.true(output.includes('Hello'));
  t.true(output.includes('How are you?'));
  t.true(output.includes('Can you help me'));
  t.true(output.includes('Enter'));
  t.true(output.includes('Esc'));
});

test.serial('UndoSelectionMenu truncates long messages', async (t) => {
  const longText = 'A'.repeat(100);
  const items: UndoItem[] = [makeItem(0, longText)];
  const { lastFrame } = await renderInAct(<UndoSelectionMenu items={items} selectedIndex={0} />, t);
  const output = lastFrame() ?? '';
  // The message should be truncated, not showing all 100 A's
  t.false(output.includes('A'.repeat(60)));
});
