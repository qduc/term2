import { expect, it } from 'vitest';
import { classifyReplayDifference } from './semantic-replay-classification.js';

it('classifies a diff as intentionally opaque only when opaque inclusion resolves it', () => {
  expect(
    classifyReplayDifference({
      category: 'history',
      opaqueDifferenceRemains: false,
      snapshotDifferenceRemains: false,
      opaqueEventRefs: 2,
      snapshotEventRefs: 0,
    }),
  ).toBe('intentional_opaque');
});

it('classifies compatibility snapshot state only when snapshot inclusion resolves a non-transcript diff', () => {
  expect(
    classifyReplayDifference({
      category: 'ledger',
      opaqueDifferenceRemains: true,
      snapshotDifferenceRemains: false,
      opaqueEventRefs: 0,
      snapshotEventRefs: 1,
    }),
  ).toBe('compatibility_snapshot');
});

it('keeps an unaccounted semantic difference in the mismatch bucket', () => {
  expect(
    classifyReplayDifference({
      category: 'transcript',
      opaqueDifferenceRemains: true,
      snapshotDifferenceRemains: false,
      opaqueEventRefs: 0,
      snapshotEventRefs: 1,
    }),
  ).toBe('mismatch');
});

it('does not call a diff intentional merely because opaque events exist', () => {
  expect(
    classifyReplayDifference({
      category: 'history',
      opaqueDifferenceRemains: true,
      snapshotDifferenceRemains: true,
      opaqueEventRefs: 4,
      snapshotEventRefs: 0,
    }),
  ).toBe('mismatch');
});
