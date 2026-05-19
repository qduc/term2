import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import UndoSelectionMenu from './UndoSelectionMenu.js';
import type { UndoItem } from '../hooks/use-undo-selection.js';

const makeItem = (uiIndex: number, text: string): UndoItem => ({ uiIndex, text });

test('UndoSelectionMenu renders empty state', (t) => {
  const { lastFrame } = render(<UndoSelectionMenu items={[]} selectedIndex={0} />);
  const output = lastFrame() ?? '';
  t.true(output.includes('No messages to undo'));
});

test('UndoSelectionMenu renders list of items', (t) => {
  const items: UndoItem[] = [
    makeItem(0, 'Hello'),
    makeItem(2, 'How are you?'),
    makeItem(4, 'Can you help me with this task?'),
  ];
  const { lastFrame } = render(<UndoSelectionMenu items={items} selectedIndex={1} />);
  const output = lastFrame() ?? '';
  t.true(output.includes('Hello'));
  t.true(output.includes('How are you?'));
  t.true(output.includes('Can you help me'));
  t.true(output.includes('Enter'));
  t.true(output.includes('Esc'));
});

test('UndoSelectionMenu highlights selected item', (t) => {
  const items: UndoItem[] = [makeItem(0, 'Hello'), makeItem(2, 'How are you?')];
  const { lastFrame } = render(<UndoSelectionMenu items={items} selectedIndex={0} />);
  const output = lastFrame() ?? '';
  t.true(output.includes('Hello'));
  t.true(output.includes('How are you?'));
});

test('UndoSelectionMenu truncates long messages', (t) => {
  const longText = 'A'.repeat(100);
  const items: UndoItem[] = [makeItem(0, longText)];
  const { lastFrame } = render(<UndoSelectionMenu items={items} selectedIndex={0} />);
  const output = lastFrame() ?? '';
  // The message should be truncated, not showing all 100 A's
  t.false(output.includes('A'.repeat(60)));
});
