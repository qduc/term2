export type ReplayDifferenceCategory = 'transcript' | 'history' | 'ledger' | 'metadata';
export type ReplayDifferenceClass = 'intentional_opaque' | 'compatibility_snapshot' | 'mismatch';

/** Classify a changed projection only when a diagnostic source ablation proves its cause. */
export function classifyReplayDifference(input: {
  category: ReplayDifferenceCategory;
  opaqueDifferenceRemains: boolean;
  snapshotDifferenceRemains: boolean;
  opaqueEventRefs: number;
  snapshotEventRefs: number;
}): ReplayDifferenceClass {
  if (input.opaqueEventRefs > 0 && !input.opaqueDifferenceRemains) return 'intentional_opaque';
  if (
    input.category !== 'transcript' &&
    input.snapshotEventRefs > 0 &&
    input.opaqueDifferenceRemains &&
    !input.snapshotDifferenceRemains
  ) {
    return 'compatibility_snapshot';
  }
  return 'mismatch';
}
