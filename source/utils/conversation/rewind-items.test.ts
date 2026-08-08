import { it, expect } from 'vitest';
import { buildRewindItems } from './rewind-items.js';
import type { RewindTarget } from '../../services/conversation/conversation-store.js';

const target = (overrides: Partial<RewindTarget> = {}): RewindTarget => {
  const turnNumber = overrides.turnNumber ?? 1;
  return {
    id: `target-${turnNumber}` as RewindTarget['id'],
    turnNumber,
    text: 'stored',
    imageCount: 0,
    discardedTurns: 1,
    discardedReplies: 0,
    discardedFiles: [],
    ...overrides,
  };
};

it('preserves store turn numbers and carries opaque target ids into the picker', () => {
  const items = buildRewindItems(
    [
      { uiIndex: 3, text: 'first' },
      { uiIndex: 7, text: 'second' },
    ],
    [target({ turnNumber: 1, text: 'first' }), target({ turnNumber: 2, text: 'second' })],
  );

  expect(items.map((item) => item.turnNumber)).toEqual([1, 2]);
  expect(items.map((item) => item.targetId)).toEqual(['target-1', 'target-2']);
});

it('prefers the UI text so the picker shows what the transcript shows', () => {
  const items = buildRewindItems([{ uiIndex: 0, text: 'ui text' }], [target({ text: 'store text' })]);

  expect(items[0]!.text).toBe('ui text');
});

it('attaches discard stats from the matching store target', () => {
  const items = buildRewindItems(
    [{ uiIndex: 0, text: 'a' }],
    [target({ discardedReplies: 4, discardedFiles: ['x.ts'], discardedTurns: 2, imageCount: 1 })],
  );

  expect(items[0]).toMatchObject({
    discardedReplies: 4,
    discardedFiles: ['x.ts'],
    discardedTurns: 2,
    imageCount: 1,
  });
});

it('aligns from the end when the store holds fewer turns than the UI', () => {
  // The store can be trimmed independently of the rendered transcript; the most
  // recent turns are the ones that must line up.
  const items = buildRewindItems(
    [
      { uiIndex: 0, text: 'oldest' },
      { uiIndex: 2, text: 'newest' },
    ],
    [target({ discardedReplies: 9 })],
  );

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    turnNumber: 1,
    text: 'newest',
    discardedReplies: 9,
  });
});

it('aligns from the end when the store holds more turns than the UI', () => {
  const items = buildRewindItems(
    [{ uiIndex: 0, text: 'only' }],
    [target({ discardedReplies: 1 }), target({ turnNumber: 2, discardedReplies: 5 })],
  );

  expect(items[0]!.discardedReplies).toBe(5);
});

it('does not offer a UI turn that has no matching store target', () => {
  const items = buildRewindItems([{ uiIndex: 0, text: 'a' }], []);

  expect(items).toEqual([]);
});

it('returns an empty list when there are no user messages', () => {
  expect(buildRewindItems([], [target()])).toEqual([]);
});
