import { isDeepStrictEqual } from 'node:util';

export type ProviderCheckpointIdentity = {
  provider: string;
  endpoint: string;
  model: string;
};

export type ProviderCheckpointPrefix = {
  revision: number;
  identity: string;
};

export type ProviderCheckpointBinding = {
  identity: ProviderCheckpointIdentity;
  prefix: ProviderCheckpointPrefix;
};

export type ProviderCheckpointRetirement = {
  code: 'reset' | 'superseded' | 'chaining_broken' | 'identity_mismatch' | 'prefix_mismatch';
};

export type ProviderCheckpointSuccessorProof = {
  revision: number;
  identity: string;
  origin?: string;
  history: readonly unknown[];
};

/** Fixed, non-sensitive explanation for why future-selector evidence is unavailable. */
export type ProviderSuccessorEligibilityFailure =
  | 'no_accepted_checkpoint'
  | 'missing_successor_proof'
  | 'lineage_mismatch'
  | 'invalid_planned_snapshot'
  | 'identity_mismatch'
  | 'origin_mismatch'
  | 'revision_not_advanced'
  | 'history_not_extended'
  | 'history_prefix_mismatch';

export type ProviderSuccessorEligibility =
  | { eligible: true }
  | { eligible: false; failure: ProviderSuccessorEligibilityFailure };

export type ProviderCheckpoint = ProviderCheckpointBinding & {
  state: 'candidate' | 'accepted' | 'retired';
  lineage: number;
  responseId: string;
  opaqueState?: unknown;
  /**
   * Immutable authoritative history captured immediately after the response was
   * committed. It is evidence for a future provider-private selector only; it
   * does not affect existing response-ID publication or wire selection.
   */
  successorProof?: ProviderCheckpointSuccessorProof;
  retirement?: ProviderCheckpointRetirement;
};

/**
 * Owns provider-side response chaining state: previousResponseId and
 * whether chaining has been broken (e.g. by transport downgrade).
 *
 * This is the single source of truth for provider continuity. All other
 * collaborators read from this object rather than storing their own copy.
 *
 * ## Chain settlement
 *
 * When a published response issued function calls, the next request must
 * supply matching tool outputs or the chain must be dropped. Outstanding
 * call ids are the local record of that unpaid server debt. Clear them only
 * when a later terminal response replaces them, or when continuity is reset.
 */
export class ProviderContinuity {
  #previousResponseId: string | null = null;
  #chainingBroken = false;
  #lineage = 0;
  #checkpoint: ProviderCheckpoint | null = null;
  #retiredCheckpoints: ProviderCheckpoint[] = [];
  /** Function-call ids the published previousResponseId still requires outputs for. */
  #outstandingToolCallIds: string[] = [];

  get previousResponseId(): string | null {
    return this.#previousResponseId;
  }

  get chainingBroken(): boolean {
    return this.#chainingBroken;
  }

  get checkpoint(): ProviderCheckpoint | null {
    return this.#checkpoint;
  }

  get lineage(): number {
    return this.#lineage;
  }

  get retiredCheckpoints(): readonly ProviderCheckpoint[] {
    return this.#retiredCheckpoints;
  }

  /** Call ids the current chain still needs tool outputs for. */
  get outstandingToolCallIds(): readonly string[] {
    return this.#outstandingToolCallIds;
  }

  hasOutstandingToolDebt(): boolean {
    return this.#outstandingToolCallIds.length > 0;
  }

  /**
   * Replace the unpaid tool-call set for the current chain. Pass an empty
   * list when the latest terminal response left no open function calls.
   */
  replaceOutstandingToolCallIds(callIds: readonly string[]): void {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const callId of callIds) {
      if (typeof callId !== 'string' || !callId || seen.has(callId)) continue;
      seen.add(callId);
      unique.push(callId);
    }
    this.#outstandingToolCallIds = unique;
  }

  /**
   * Records a provider response observed before its terminal history is
   * committed. This deliberately does not update previousResponseId: existing
   * wire continuity remains owned by update().
   */
  observeCandidate(
    candidate: ProviderCheckpointBinding & { responseId: string; opaqueState?: unknown; lineage?: number },
  ): boolean {
    if (candidate.lineage !== undefined && candidate.lineage !== this.#lineage) {
      return false;
    }
    this.#retireCheckpoint('superseded');
    this.#checkpoint = {
      ...candidate,
      lineage: this.#lineage,
      state: 'candidate',
    };
    return true;
  }

  /**
   * Accepts only the candidate for this exact terminal response and binding.
   * Call this in the same current-generation callback that committed history.
   */
  promoteCandidate(responseId: string | null, binding?: ProviderCheckpointBinding): boolean {
    const checkpoint = this.#checkpoint;
    if (
      !checkpoint ||
      checkpoint.state !== 'candidate' ||
      checkpoint.lineage !== this.#lineage ||
      checkpoint.responseId !== responseId
    ) {
      return false;
    }
    if (binding) {
      const retirement = ProviderContinuity.#bindingMismatch(checkpoint, binding);
      if (retirement) {
        this.#retireCheckpoint(retirement);
        return false;
      }
    }
    this.#checkpoint = { ...checkpoint, state: 'accepted' };
    return true;
  }

  update(responseId: string | null): void {
    this.#previousResponseId = responseId;
  }

  /**
   * Publishes the terminal response ID using the established legacy state and,
   * only after an authoritative history commit, accepts a matching observed
   * checkpoint as corroborating evidence. This does not select a checkpoint
   * for a future request.
   */
  publishTerminalResponse(
    responseId: string | null,
    historyCommitted: boolean,
    postCommitSnapshot?: ProviderCheckpointSuccessorProof,
  ): boolean {
    this.update(responseId);
    const promoted = historyCommitted && this.promoteCandidate(responseId);
    if (promoted && postCommitSnapshot) {
      this.#attachSuccessorProof(postCommitSnapshot);
    }
    return promoted;
  }

  /**
   * Pure, fail-closed characterization for a future OpenAI-private selector.
   * A successor must preserve the committed transcript exactly and add to it;
   * this does not select or publish a previous response ID.
   */
  isEligibleForSuccessor(
    identity: ProviderCheckpointIdentity,
    lineage: number,
    plannedSnapshot: ProviderCheckpointSuccessorProof,
  ): boolean {
    return this.assessSuccessorEligibility(identity, lineage, plannedSnapshot).eligible;
  }

  /**
   * Read-only, fail-closed eligibility assessment for bounded diagnostics.
   * Its fixed failure enum contains no provider IDs, history, or request data.
   */
  assessSuccessorEligibility(
    identity: ProviderCheckpointIdentity,
    lineage: number,
    plannedSnapshot: ProviderCheckpointSuccessorProof,
  ): ProviderSuccessorEligibility {
    const checkpoint = this.#checkpoint;
    const proof = checkpoint?.successorProof;
    if (!checkpoint || checkpoint.state !== 'accepted') return { eligible: false, failure: 'no_accepted_checkpoint' };
    if (checkpoint.lineage !== lineage) return { eligible: false, failure: 'lineage_mismatch' };
    if (!proof) return { eligible: false, failure: 'missing_successor_proof' };
    if (!ProviderContinuity.#isSnapshotProof(plannedSnapshot)) {
      return { eligible: false, failure: 'invalid_planned_snapshot' };
    }
    if (!ProviderContinuity.#identityMatches(checkpoint.identity, identity)) {
      return { eligible: false, failure: 'identity_mismatch' };
    }
    if (!proof.origin || proof.origin !== plannedSnapshot.origin)
      return { eligible: false, failure: 'origin_mismatch' };
    if (plannedSnapshot.revision <= proof.revision) return { eligible: false, failure: 'revision_not_advanced' };
    if (plannedSnapshot.history.length <= proof.history.length)
      return { eligible: false, failure: 'history_not_extended' };
    try {
      return proof.history.every((item, index) => isDeepStrictEqual(item, plannedSnapshot.history[index]))
        ? { eligible: true }
        : { eligible: false, failure: 'history_prefix_mismatch' };
    } catch {
      return { eligible: false, failure: 'history_prefix_mismatch' };
    }
  }

  clear(): void {
    this.#previousResponseId = null;
    this.#outstandingToolCallIds = [];
    this.#retireCheckpoint('reset');
    this.#lineage++;
  }

  breakChaining(): void {
    this.#previousResponseId = null;
    this.#outstandingToolCallIds = [];
    this.#chainingBroken = true;
    this.#retireCheckpoint('chaining_broken');
  }

  isChainingAvailable(historyLength?: number): boolean {
    return !this.#chainingBroken && (this.#previousResponseId !== null || (historyLength ?? 0) <= 1);
  }

  #retireCheckpoint(code: ProviderCheckpointRetirement['code']): void {
    if (!this.#checkpoint) return;
    this.#retiredCheckpoints.push({ ...this.#checkpoint, state: 'retired', retirement: { code } });
    this.#checkpoint = null;
  }

  #attachSuccessorProof(snapshot: ProviderCheckpointSuccessorProof): void {
    const checkpoint = this.#checkpoint;
    if (!checkpoint || checkpoint.state !== 'accepted') return;
    try {
      const proof = ProviderContinuity.#freezeSnapshot(snapshot);
      this.#checkpoint = { ...checkpoint, successorProof: proof };
    } catch {
      // This is characterization evidence only. A cloning failure must not
      // change the already-established terminal publication behavior.
    }
  }

  static #freezeSnapshot(snapshot: ProviderCheckpointSuccessorProof): ProviderCheckpointSuccessorProof {
    return Object.freeze({
      revision: snapshot.revision,
      identity: snapshot.identity,
      origin: snapshot.origin,
      history: ProviderContinuity.#deepFreeze(structuredClone(snapshot.history)),
    });
  }

  static #deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
    if (!value || typeof value !== 'object' || seen.has(value as object)) return value;
    seen.add(value as object);
    for (const child of Object.values(value as object)) ProviderContinuity.#deepFreeze(child, seen);
    return Object.freeze(value);
  }

  static #identityMatches(left: ProviderCheckpointIdentity, right: ProviderCheckpointIdentity): boolean {
    return left.provider === right.provider && left.endpoint === right.endpoint && left.model === right.model;
  }

  static #isSnapshotProof(value: unknown): value is ProviderCheckpointSuccessorProof {
    const snapshot = value as Partial<ProviderCheckpointSuccessorProof> | null;
    return !!(
      snapshot &&
      Number.isSafeInteger(snapshot.revision) &&
      typeof snapshot.identity === 'string' &&
      snapshot.identity.length > 0 &&
      typeof snapshot.origin === 'string' &&
      snapshot.origin.length > 0 &&
      Array.isArray(snapshot.history)
    );
  }

  static #bindingMismatch(
    left: ProviderCheckpointBinding,
    right: ProviderCheckpointBinding,
  ): ProviderCheckpointRetirement['code'] | null {
    if (!ProviderContinuity.#identityMatches(left.identity, right.identity)) {
      return 'identity_mismatch';
    }
    if (left.prefix.revision !== right.prefix.revision || left.prefix.identity !== right.prefix.identity) {
      return 'prefix_mismatch';
    }
    return null;
  }
}
