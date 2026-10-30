/**
 * Session-owned, fail-closed bridge from the OpenAI private lifecycle seam to
 * the continuity candidate lifecycle. Promotion remains SessionStreamProcessor's
 * responsibility after the authoritative history commit.
 */
export class OpenAICandidateObserver {
    continuity;
    lifecycleObserver;
    rootProviderIdentity;
    constructor(continuity, lifecycleObserver, rootProviderIdentity) {
        this.continuity = continuity;
        this.lifecycleObserver = lifecycleObserver;
        this.rootProviderIdentity = rootProviderIdentity;
    }
    record() {
        // Candidate observation intentionally ignores request-projection telemetry.
    }
    observe(observation) {
        if (observation.phase !== 'terminal')
            return;
        if (!observation.prefixBinding) {
            this.lifecycleObserver?.candidate(observation.prefixBindingOutcome ?? 'missing_prefix_binding');
            return;
        }
        if (!observation.responseId) {
            this.lifecycleObserver?.candidate('missing_response_id');
            return;
        }
        if (typeof observation.prefixBinding.lineage !== 'number') {
            this.lifecycleObserver?.candidate('invalid_lineage');
            return;
        }
        try {
            const identity = {
                provider: observation.provider,
                endpoint: observation.endpoint,
                model: observation.model,
            };
            this.rootProviderIdentity?.observe(identity);
            const observed = this.continuity.observeCandidate({
                identity,
                prefix: {
                    identity: observation.prefixBinding.snapshotIdentity,
                    revision: observation.prefixBinding.snapshotRevision,
                },
                lineage: observation.prefixBinding.lineage,
                responseId: observation.responseId,
            });
            this.lifecycleObserver?.candidate(observed ? 'observed' : 'lineage_rejected');
        }
        catch {
            // Provider observation must never alter a request or terminal stream.
        }
    }
}
//# sourceMappingURL=openai-candidate-observer.js.map