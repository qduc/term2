// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import RewindMenu from './RewindMenu.js';
import type { RewindItem } from '../../hooks/use-rewind-selection.js';

const makeItem = (overrides: Partial<RewindItem> = {}): RewindItem => ({
  turnNumber: 1,
  text: 'do the thing',
  imageCount: 0,
  discardedTurns: 1,
  discardedReplies: 1,
  discardedFiles: [],
  ...overrides,
});

it.sequential('renders the empty state when there is nothing to rewind', async () => {
  const { lastFrame } = await renderInAct(<RewindMenu items={[]} selectedIndex={0} disposition="edit" />);
  expect(lastFrame() ?? '').toContain('Nothing to rewind');
});

it.sequential('renders each turn text', async () => {
  const items = [
    makeItem({ turnNumber: 1, text: 'add retry logic' }),
    makeItem({ turnNumber: 2, text: 'now make the tests pass' }),
  ];
  const { lastFrame } = await renderInAct(<RewindMenu items={items} selectedIndex={1} disposition="edit" />);
  const output = lastFrame() ?? '';

  expect(output).toContain('add retry logic');
  expect(output).toContain('now make the tests pass');
});

it.sequential('states what a rewind would discard', async () => {
  const items = [makeItem({ discardedReplies: 3, discardedFiles: ['a.ts', 'b.ts'] })];
  const { lastFrame } = await renderInAct(<RewindMenu items={items} selectedIndex={0} disposition="edit" />);
  const output = lastFrame() ?? '';

  expect(output).toContain('3 replies');
  expect(output).toContain('2 files');
});

it.sequential('uses singular wording for a single reply and file', async () => {
  const items = [makeItem({ discardedReplies: 1, discardedFiles: ['a.ts'] })];
  const { lastFrame } = await renderInAct(<RewindMenu items={items} selectedIndex={0} disposition="edit" />);
  const output = lastFrame() ?? '';

  expect(output).toContain('1 reply');
  expect(output).toContain('1 file');
  expect(output).not.toContain('1 replies');
  expect(output).not.toContain('1 files');
});

it.sequential('marks an unanswered trailing turn instead of claiming zero discards', async () => {
  const items = [makeItem({ discardedReplies: 0, discardedFiles: [] })];
  const { lastFrame } = await renderInAct(<RewindMenu items={items} selectedIndex={0} disposition="edit" />);

  expect(lastFrame() ?? '').toContain('no reply yet');
});

it.sequential('reports how many turns a multi-turn rewind drops', async () => {
  const items = [makeItem({ discardedTurns: 4, discardedReplies: 5 })];
  const { lastFrame } = await renderInAct(<RewindMenu items={items} selectedIndex={0} disposition="edit" />);

  expect(lastFrame() ?? '').toContain('4 turns');
});

it.sequential('does not report turn count for a single-turn rewind', async () => {
  const items = [makeItem({ discardedTurns: 1, discardedReplies: 2 })];
  const { lastFrame } = await renderInAct(<RewindMenu items={items} selectedIndex={0} disposition="edit" />);

  expect(lastFrame() ?? '').not.toContain('1 turns');
});

it.sequential('notes attached images on a multimodal turn', async () => {
  const items = [makeItem({ imageCount: 2 })];
  const { lastFrame } = await renderInAct(<RewindMenu items={items} selectedIndex={0} disposition="edit" />);

  expect(lastFrame() ?? '').toContain('2 images');
});

it.sequential('footer names the edit action when the disposition is edit', async () => {
  const { lastFrame } = await renderInAct(<RewindMenu items={[makeItem()]} selectedIndex={0} disposition="edit" />);
  const output = lastFrame() ?? '';

  expect(output).toContain('rewind & edit');
  expect(output).toContain('resend instead');
});

it.sequential('footer names the resend action when the disposition is resend', async () => {
  const { lastFrame } = await renderInAct(<RewindMenu items={[makeItem()]} selectedIndex={0} disposition="resend" />);
  const output = lastFrame() ?? '';

  expect(output).toContain('rewind & resend');
  expect(output).toContain('edit instead');
});

it.sequential('truncates a long turn text', async () => {
  const items = [makeItem({ text: 'A'.repeat(200) })];
  const { lastFrame } = await renderInAct(<RewindMenu items={items} selectedIndex={0} disposition="edit" />);

  expect(lastFrame() ?? '').not.toContain('A'.repeat(150));
});

it.sequential('shows the first mutated file names so the cost is concrete', async () => {
  const items = [makeItem({ discardedFiles: ['source/a.ts', 'source/b.ts'] })];
  const { lastFrame } = await renderInAct(<RewindMenu items={items} selectedIndex={0} disposition="edit" />);
  const output = lastFrame() ?? '';

  expect(output).toContain('a.ts');
});

it.sequential('separates rows with a blank line but does not trail one after the last', async () => {
  const items = [makeItem({ turnNumber: 1 }), makeItem({ turnNumber: 2 })];
  const { lastFrame } = await renderInAct(<RewindMenu items={items} selectedIndex={0} disposition="edit" />);
  const lines = (lastFrame() ?? '').split('\n');

  // Two entries at two lines each, one separator between them.
  const blankInterior = lines.slice(1, -2).filter((line) => line.replace(/[│╭╮╰╯─]/g, '').trim() === '').length;
  expect(blankInterior).toBe(1);
});
