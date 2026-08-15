import { expect, it } from 'vitest';
import type { AgentStream } from './agent-stream.js';
import { extractFinalizationSnapshot, extractHistoryLength, extractReplaySnapshot } from './stream-snapshot.js';

const streamLike = (overrides: Record<string, unknown> = {}) =>
  ({
    history: [{ type: 'item', id: 'h-1' }],
    newItems: ['n-1'],
    output: ['o-1'],
    lastResponseId: 'resp-1',
    ...overrides,
  } as unknown as AgentStream);

it('extractReplaySnapshot returns history and newItems from a well-formed stream', () => {
  const snapshot = extractReplaySnapshot(streamLike());

  expect(snapshot).toEqual({ history: [{ type: 'item', id: 'h-1' }], newItems: ['n-1'] });
});

it('extractReplaySnapshot degrades each absent or non-array field to an empty array', () => {
  for (const history of [undefined, null, 'not-an-array', {}]) {
    expect(extractReplaySnapshot(streamLike({ history })).history).toEqual([]);
  }
  for (const newItems of [undefined, null, 0, {}]) {
    expect(extractReplaySnapshot(streamLike({ newItems })).newItems).toEqual([]);
  }
});

it('extractFinalizationSnapshot returns all fields including lastResponseId from a well-formed stream', () => {
  const snapshot = extractFinalizationSnapshot(streamLike());

  expect(snapshot).toEqual({
    history: [{ type: 'item', id: 'h-1' }],
    newItems: ['n-1'],
    output: ['o-1'],
    lastResponseId: 'resp-1',
  });
});

it('extractFinalizationSnapshot degrades each absent or non-array field to an empty array', () => {
  for (const history of [undefined, null, 'not-an-array', {}]) {
    expect(extractFinalizationSnapshot(streamLike({ history })).history).toEqual([]);
  }
  for (const newItems of [undefined, null, 0, {}]) {
    expect(extractFinalizationSnapshot(streamLike({ newItems })).newItems).toEqual([]);
  }
  for (const output of [undefined, null, 'not-an-array', {}]) {
    expect(extractFinalizationSnapshot(streamLike({ output })).output).toEqual([]);
  }
});

it('extractFinalizationSnapshot falls back to null lastResponseId when absent', () => {
  expect(extractFinalizationSnapshot(streamLike({ lastResponseId: undefined })).lastResponseId).toBeNull();
});

it('extractHistoryLength returns the history array length', () => {
  expect(extractHistoryLength(streamLike())).toBe(1);
});

it('extractHistoryLength returns 0 for a null stream', () => {
  expect(extractHistoryLength(null)).toBe(0);
});

it('extractHistoryLength returns 0 for absent or non-array history', () => {
  for (const overrides of [{ history: undefined }, { history: 'not-an-array' }, { history: null }]) {
    expect(extractHistoryLength(streamLike(overrides))).toBe(0);
  }
});
