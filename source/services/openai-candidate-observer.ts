import type {
  ProviderRequestCapture,
  OpenAIRequestLifecycleObservation,
} from '../providers/provider-request-capture.js';
import type { ProviderContinuity } from './provider-continuity.js';

/**
 * Session-owned, fail-closed bridge from the OpenAI private lifecycle seam to
 * the continuity candidate lifecycle. Promotion remains SessionStreamProcessor's
 * responsibility after the authoritative history commit.
 */
export class OpenAICandidateObserver implements ProviderRequestCapture {
  constructor(private readonly continuity: ProviderContinuity) {}

  record(): void {
    // Candidate observation intentionally ignores request-projection telemetry.
  }

  observe(observation: OpenAIRequestLifecycleObservation): void {
    if (
      observation.phase !== 'terminal' ||
      !observation.responseId ||
      !observation.prefixBinding ||
      typeof observation.prefixBinding.lineage !== 'number'
    )
      return;
    try {
      this.continuity.observeCandidate({
        identity: {
          provider: observation.provider,
          endpoint: observation.endpoint,
          model: observation.model,
        },
        prefix: {
          identity: observation.prefixBinding.snapshotIdentity,
          revision: observation.prefixBinding.snapshotRevision,
        },
        lineage: observation.prefixBinding.lineage,
        responseId: observation.responseId,
      });
    } catch {
      // Provider observation must never alter a request or terminal stream.
    }
  }
}
