import type { ProviderHistorySnapshot } from './conversation/conversation-store.js';
import type { ProviderContinuity } from './provider-continuity.js';

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
  version: 1;
  eligible: boolean;
  matches: boolean;
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
      const checkpoint = this.continuity.checkpoint;
      const acceptedCheckpointResponseId = checkpoint?.state === 'accepted' ? checkpoint.responseId : null;
      const eligible =
        typeof model === 'string' &&
        model.length > 0 &&
        this.continuity.isEligibleForSuccessor(
          { provider: 'openai', endpoint: 'responses', model },
          this.continuity.lineage,
          plannedSnapshot,
        );
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
          version: 1,
          eligible,
          matches: observation.matches,
        }),
      );
    } catch {
      // Observation must never affect an established request.
    }
  }
}
