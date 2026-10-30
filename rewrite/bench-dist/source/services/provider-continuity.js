var _a;
import { isDeepStrictEqual } from 'node:util';
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
    #previousResponseId = null;
    #chainingBroken = false;
    #lineage = 0;
    #checkpoint = null;
    #retiredCheckpoints = [];
    /** Function-call ids the published previousResponseId still requires outputs for. */
    #outstandingToolCallIds = [];
    get previousResponseId() {
        return this.#previousResponseId;
    }
    get chainingBroken() {
        return this.#chainingBroken;
    }
    get checkpoint() {
        return this.#checkpoint;
    }
    get lineage() {
        return this.#lineage;
    }
    get retiredCheckpoints() {
        return this.#retiredCheckpoints;
    }
    /** Call ids the current chain still needs tool outputs for. */
    get outstandingToolCallIds() {
        return this.#outstandingToolCallIds;
    }
    hasOutstandingToolDebt() {
        return this.#outstandingToolCallIds.length > 0;
    }
    /**
     * Replace the unpaid tool-call set for the current chain. Pass an empty
     * list when the latest terminal response left no open function calls.
     */
    replaceOutstandingToolCallIds(callIds) {
        const unique = [];
        const seen = new Set();
        for (const callId of callIds) {
            if (typeof callId !== 'string' || !callId || seen.has(callId))
                continue;
            seen.add(callId);
            unique.push(callId);
        }
        this.#outstandingToolCallIds = unique;
    }
    /** A new user request cannot leave the preceding response's tool debt unpaid. */
    prepareNewTurn(historyLength) {
        const hadDebt = this.hasOutstandingToolDebt();
        if (hadDebt && this.#previousResponseId)
            this.clear();
        return !hadDebt && this.isChainingAvailable(historyLength);
    }
    /** Keep response identity and lineage encoding inside their protocol owner. */
    prepareRequest(options, view) {
        const request = {
            ...options,
            previousResponseId: view.kind === 'continuation'
                ? this.#previousResponseId
                : view.disableChaining
                    ? undefined
                    : view.inputMode === 'delta'
                        ? this.#previousResponseId
                        : null,
        };
        Object.defineProperty(request, 'providerContinuityLineage', {
            value: this.#lineage,
            enumerable: this.#lineage !== 0,
        });
        return request;
    }
    /**
     * Records a provider response observed before its terminal history is
     * committed. This deliberately does not update previousResponseId: existing
     * wire continuity remains owned by update().
     */
    observeCandidate(candidate) {
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
    promoteCandidate(responseId, binding) {
        const checkpoint = this.#checkpoint;
        if (!checkpoint ||
            checkpoint.state !== 'candidate' ||
            checkpoint.lineage !== this.#lineage ||
            checkpoint.responseId !== responseId) {
            return false;
        }
        if (binding) {
            const retirement = _a.#bindingMismatch(checkpoint, binding);
            if (retirement) {
                this.#retireCheckpoint(retirement);
                return false;
            }
        }
        this.#checkpoint = { ...checkpoint, state: 'accepted' };
        return true;
    }
    update(responseId) {
        this.#previousResponseId = responseId;
    }
    /**
     * Publishes the terminal response ID using the established legacy state and,
     * only after an authoritative history commit, accepts a matching observed
     * checkpoint as corroborating evidence. This does not select a checkpoint
     * for a future request.
     */
    publishTerminalResponse(responseId, historyCommitted, postCommitSnapshot) {
        this.update(responseId);
        const promoted = historyCommitted && this.promoteCandidate(responseId);
        if (promoted && postCommitSnapshot) {
            this.#attachSuccessorProof(postCommitSnapshot);
        }
        return promoted;
    }
    /**
     * Synchronous, in-memory protocol update. Record acceptance has already
     * happened; diagnostics cannot undo it or turn it into a replayable failure.
     */
    acceptSegment(segment, observer) {
        const hadCandidate = this.#checkpoint?.state === 'candidate';
        let promoted = false;
        if (segment.kind === 'committed') {
            promoted = this.publishTerminalResponse(segment.lastResponseId, segment.historyCommitted, segment.snapshot);
        }
        else
            this.update(segment.lastResponseId);
        this.replaceOutstandingToolCallIds(segment.unsettledToolCallIds);
        if (segment.kind === 'committed' && hadCandidate) {
            try {
                observer?.publication(!segment.historyCommitted ? 'history_not_committed' : promoted ? 'promoted' : 'candidate_not_promoted');
            }
            catch {
                // Observability must not reject an accepted external effect.
            }
        }
    }
    /**
     * Pure, fail-closed characterization for a future OpenAI-private selector.
     * A successor must preserve the committed transcript exactly and add to it;
     * this does not select or publish a previous response ID.
     */
    isEligibleForSuccessor(identity, lineage, plannedSnapshot) {
        return this.assessSuccessorEligibility(identity, lineage, plannedSnapshot).eligible;
    }
    /**
     * Read-only, fail-closed eligibility assessment for bounded diagnostics.
     * Its fixed failure enum contains no provider IDs, history, or request data.
     */
    assessSuccessorEligibility(identity, lineage, plannedSnapshot) {
        const checkpoint = this.#checkpoint;
        const proof = checkpoint?.successorProof;
        if (!checkpoint || checkpoint.state !== 'accepted')
            return { eligible: false, failure: 'no_accepted_checkpoint' };
        if (checkpoint.lineage !== lineage)
            return { eligible: false, failure: 'lineage_mismatch' };
        if (!proof)
            return { eligible: false, failure: 'missing_successor_proof' };
        if (!_a.#isSnapshotProof(plannedSnapshot)) {
            return { eligible: false, failure: 'invalid_planned_snapshot' };
        }
        if (!_a.#identityMatches(checkpoint.identity, identity)) {
            return { eligible: false, failure: 'identity_mismatch' };
        }
        if (!proof.origin || proof.origin !== plannedSnapshot.origin)
            return { eligible: false, failure: 'origin_mismatch' };
        if (plannedSnapshot.revision <= proof.revision)
            return { eligible: false, failure: 'revision_not_advanced' };
        if (plannedSnapshot.history.length <= proof.history.length)
            return { eligible: false, failure: 'history_not_extended' };
        try {
            return proof.history.every((item, index) => isDeepStrictEqual(item, plannedSnapshot.history[index]))
                ? { eligible: true }
                : { eligible: false, failure: 'history_prefix_mismatch' };
        }
        catch {
            return { eligible: false, failure: 'history_prefix_mismatch' };
        }
    }
    clear() {
        this.#previousResponseId = null;
        this.#outstandingToolCallIds = [];
        this.#retireCheckpoint('reset');
        this.#lineage++;
    }
    breakChaining() {
        this.#previousResponseId = null;
        this.#outstandingToolCallIds = [];
        this.#chainingBroken = true;
        this.#retireCheckpoint('chaining_broken');
    }
    isChainingAvailable(historyLength) {
        return !this.#chainingBroken && (this.#previousResponseId !== null || (historyLength ?? 0) <= 1);
    }
    #retireCheckpoint(code) {
        if (!this.#checkpoint)
            return;
        this.#retiredCheckpoints.push({ ...this.#checkpoint, state: 'retired', retirement: { code } });
        this.#checkpoint = null;
    }
    #attachSuccessorProof(snapshot) {
        const checkpoint = this.#checkpoint;
        if (!checkpoint || checkpoint.state !== 'accepted')
            return;
        try {
            const proof = _a.#freezeSnapshot(snapshot);
            this.#checkpoint = { ...checkpoint, successorProof: proof };
        }
        catch {
            // This is characterization evidence only. A cloning failure must not
            // change the already-established terminal publication behavior.
        }
    }
    static #freezeSnapshot(snapshot) {
        return Object.freeze({
            revision: snapshot.revision,
            identity: snapshot.identity,
            origin: snapshot.origin,
            history: _a.#deepFreeze(structuredClone(snapshot.history)),
        });
    }
    static #deepFreeze(value, seen = new WeakSet()) {
        if (!value || typeof value !== 'object' || seen.has(value))
            return value;
        seen.add(value);
        for (const child of Object.values(value))
            _a.#deepFreeze(child, seen);
        return Object.freeze(value);
    }
    static #identityMatches(left, right) {
        return left.provider === right.provider && left.endpoint === right.endpoint && left.model === right.model;
    }
    static #isSnapshotProof(value) {
        const snapshot = value;
        return !!(snapshot &&
            Number.isSafeInteger(snapshot.revision) &&
            typeof snapshot.identity === 'string' &&
            snapshot.identity.length > 0 &&
            typeof snapshot.origin === 'string' &&
            snapshot.origin.length > 0 &&
            Array.isArray(snapshot.history));
    }
    static #bindingMismatch(left, right) {
        if (!_a.#identityMatches(left.identity, right.identity)) {
            return 'identity_mismatch';
        }
        if (left.prefix.revision !== right.prefix.revision || left.prefix.identity !== right.prefix.identity) {
            return 'prefix_mismatch';
        }
        return null;
    }
}
_a = ProviderContinuity;
//# sourceMappingURL=provider-continuity.js.map