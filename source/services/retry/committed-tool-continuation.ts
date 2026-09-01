import type { ClassifiedFailure, CommittedToolContinuation } from './retry-contracts.js';

export function isSettledCommittedToolContinuation(evidence: CommittedToolContinuation | undefined): boolean {
  return (
    evidence !== undefined &&
    evidence.completedToolCount > 0 &&
    evidence.allToolsCompleted &&
    evidence.completedPairsPresentInHistory
  );
}

export function skipsAutomaticReplayClaim(
  failure: ClassifiedFailure,
  evidence: CommittedToolContinuation | undefined,
): boolean {
  return (
    failure.kind === 'chain_recovery' &&
    failure.cause === 'connection_interrupted' &&
    isSettledCommittedToolContinuation(evidence)
  );
}
