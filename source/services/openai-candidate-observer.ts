import type {
  ProviderRequestCapture,
  OpenAIRequestLifecycleObservation,
} from '../providers/provider-request-capture.js';
import type { ProviderContinuity } from './provider-continuity.js';
import type { OpenAIRootCheckpointLifecycleObserver } from './openai-root-checkpoint-lifecycle-observer.js';
import type { OpenAIRootProviderIdentity } from './openai-root-provider-identity.js';

/**
 * Session-owned, fail-closed bridge from the OpenAI private lifecycle seam to
 * the continuity candidate lifecycle. Promotion remains SessionStreamProcessor's
 * responsibility after the authoritative history commit.
 */
export class OpenAICandidateObserver implements ProviderRequestCapture {
  constructor(
    private readonly continuity: ProviderContinuity,
    private readonly lifecycleObserver?: OpenAIRootCheckpointLifecycleObserver,
    private readonly rootProviderIdentity?: OpenAIRootProviderIdentity,
  ) {}

  record(): void {
    // Candidate observation intentionally ignores request-projection telemetry.
  }

  observe(observation: OpenAIRequestLifecycleObservation): void {
    if (observation.phase !== 'terminal') return;
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
    } catch {
      // Provider observation must never alter a request or terminal stream.
    }
  }
}
