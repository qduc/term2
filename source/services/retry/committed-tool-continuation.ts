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
 * Provider-state rejection admission.
 *
 * A provider *state* rejection (e.g. 400 `Invalid previous_response_id`,
 * `previous_response_not_found`) means the server refused the chained request
 * before accepting anything, so chain recovery -- break the chain, rebuild the
 * full request from durable history -- cannot replay committed work. It is not
 * a replay.
 *
 * Requirement: every live-turn tool completed locally. How many tools are open
 * or unknown is the only thing that can turn recovery into a replay of a tool
 * that may have run, so it stays guarded (same `allToolsCompleted` /
 * `completedToolCount > 0` rule as `isSettledCommittedToolContinuation`).
 *
 * The request-scoped `completedPairsPresentInHistory` check is deliberately
 * *not* required here. The completed pairs are already durable in the tool
 * ledger, but a provider compaction boundary makes `projectProviderHistory`
 * refuse to insert them behind the boundary -- so the pairs can be durable and
 * still absent from the projected request. Recovery still does not replay them
 * (the `retry_fresh` executor settles the ledger into history before the
 * full-history rebuild), so refusing the turn on that projection detail is a
 * false negative that kills an otherwise healthy mid-turn continuation.
 */
export function admitsProviderStateRejectionRecovery(evidence: CommittedToolContinuation | undefined): boolean {
  return evidence !== undefined && evidence.completedToolCount > 0 && evidence.allToolsCompleted;
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
