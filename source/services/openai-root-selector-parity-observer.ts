import type { ProviderHistorySnapshot } from './conversation/conversation-store.js';
import type {
  ProviderCheckpointIdentity,
  ProviderContinuity,
  ProviderSuccessorEligibilityFailure,
} from './provider-continuity.js';

export type OpenAIRootSelectorParityFailure =
  | ProviderSuccessorEligibilityFailure
  | 'model_unavailable'
  | 'identity_unavailable';

/** Read-only evidence from a normal owned-root OpenAI turn, never a selector. */
export type OpenAIRootFreshTurnSelectorParityObservation = {
  eligible: boolean;
  legacyPreviousResponseId: string;
  acceptedCheckpointResponseId: string | null;
  matches: boolean;
};

/**
 * The durable diagnostic shape intentionally excludes response IDs and all
 * request/transcript data. It is evidence for a later review, never selector
 * input or continuity state.
 */
export type OpenAIRootFreshTurnSelectorParityEvidence = {
  type: 'openai_root_selector_parity';
  version: 2;
  eligible: boolean;
  matches: boolean;
  /** Present only for an ineligible observation; a fixed diagnostic enum. */
  failure?: OpenAIRootSelectorParityFailure;
};

export interface OpenAIRootFreshTurnSelectorParityObserver {
  /** Most recent bounded observation; no transcript or request metadata is retained. */
  readonly latestObservation: Readonly<OpenAIRootFreshTurnSelectorParityObservation> | null;
  setEvidenceRecorder?(recorder: (evidence: OpenAIRootFreshTurnSelectorParityEvidence) => void): void;
  observe(input: { legacyPreviousResponseId: string; plannedSnapshot: ProviderHistorySnapshot }): void;
}

/** Owned-root-only, fail-closed checkpoint/legacy parity observation. */
export class ProviderContinuityOpenAIRootSelectorParityObserver implements OpenAIRootFreshTurnSelectorParityObserver {
  #latestObservation: Readonly<OpenAIRootFreshTurnSelectorParityObservation> | null = null;

  constructor(
    private readonly continuity: ProviderContinuity,
    private readonly getModel: () => string | undefined,
    private recordEvidence: (evidence: OpenAIRootFreshTurnSelectorParityEvidence) => void = () => {},
    private readonly getResolvedIdentity: () => Readonly<ProviderCheckpointIdentity> | null = () => null,
  ) {}

  get latestObservation(): Readonly<OpenAIRootFreshTurnSelectorParityObservation> | null {
    return this.#latestObservation;
  }

  setEvidenceRecorder(recorder: (evidence: OpenAIRootFreshTurnSelectorParityEvidence) => void): void {
    this.recordEvidence = recorder;
  }

  observe({
    legacyPreviousResponseId,
    plannedSnapshot,
  }: {
    legacyPreviousResponseId: string;
    plannedSnapshot: ProviderHistorySnapshot;
  }): void {
    try {
      const model = this.getModel();
      const resolvedIdentity = this.getResolvedIdentity();
      const checkpoint = this.continuity.checkpoint;
      const acceptedCheckpointResponseId = checkpoint?.state === 'accepted' ? checkpoint.responseId : null;
      const assessment =
        typeof model === 'string' && model.length > 0 && resolvedIdentity
          ? this.continuity.assessSuccessorEligibility(
              { ...resolvedIdentity, model },
              this.continuity.lineage,
              plannedSnapshot,
            )
          : {
              eligible: false as const,
              failure:
                typeof model === 'string' && model.length > 0
                  ? ('identity_unavailable' as const)
                  : ('model_unavailable' as const),
            };
      const eligible = assessment.eligible;
      const observation = Object.freeze({
        eligible,
        legacyPreviousResponseId,
        acceptedCheckpointResponseId,
        matches: eligible && acceptedCheckpointResponseId === legacyPreviousResponseId,
      });
      this.#latestObservation = observation;
      this.recordEvidence(
        Object.freeze({
          type: 'openai_root_selector_parity',
          version: 2,
          eligible,
          matches: observation.matches,
          ...(!eligible ? { failure: assessment.failure } : {}),
        }),
      );
    } catch {
      // Observation must never affect an established request.
    }
  }
}
