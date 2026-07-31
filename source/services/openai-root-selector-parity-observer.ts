import type { ProviderHistorySnapshot } from './conversation/conversation-store.js';
import type { ProviderContinuity } from './provider-continuity.js';

/** Read-only evidence from a normal owned-root OpenAI turn, never a selector. */
export type OpenAIRootFreshTurnSelectorParityObservation = {
  eligible: boolean;
  legacyPreviousResponseId: string;
  acceptedCheckpointResponseId: string | null;
  matches: boolean;
};

export interface OpenAIRootFreshTurnSelectorParityObserver {
  /** Most recent bounded observation; no transcript or request metadata is retained. */
  readonly latestObservation: Readonly<OpenAIRootFreshTurnSelectorParityObservation> | null;
  observe(input: { legacyPreviousResponseId: string; plannedSnapshot: ProviderHistorySnapshot }): void;
}

/** Owned-root-only, fail-closed checkpoint/legacy parity observation. */
export class ProviderContinuityOpenAIRootSelectorParityObserver
  implements OpenAIRootFreshTurnSelectorParityObserver
{
  #latestObservation: Readonly<OpenAIRootFreshTurnSelectorParityObservation> | null = null;

  constructor(
    private readonly continuity: ProviderContinuity,
    private readonly getModel: () => string | undefined,
    private readonly recordObservation: (observation: OpenAIRootFreshTurnSelectorParityObservation) => void = () => {},
  ) {}

  get latestObservation(): Readonly<OpenAIRootFreshTurnSelectorParityObservation> | null {
    return this.#latestObservation;
  }

  observe({ legacyPreviousResponseId, plannedSnapshot }: {
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
      this.recordObservation(observation);
    } catch {
      // Observation must never affect an established request.
    }
  }
}
