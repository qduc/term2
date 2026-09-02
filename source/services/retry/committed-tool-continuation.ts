import type { ClassifiedFailure, CommittedToolContinuation } from './retry-contracts.js';

export function isSettledCommittedToolContinuation(evidence: CommittedToolContinuation | undefined): boolean {
  return (
    evidence !== undefined &&
    evidence.completedToolCount > 0 &&
    evidence.allToolsCompleted &&
    evidence.completedPairsPresentInHistory
  );
}

/**
 * Chain recovery rebuilds from durable history instead of replaying committed
 * work. Once every live-turn tool pair is settled, that is true for both a
 * connection interruption and an explicit provider-state rejection.
 */
export function skipsAutomaticReplayClaim(
  failure: ClassifiedFailure,
  evidence: CommittedToolContinuation | undefined,
): boolean {
  return failure.kind === 'chain_recovery' && isSettledCommittedToolContinuation(evidence);
}
