import type { ProviderFailureKind } from '../retry/provider-failure-classification.js';
import type { FailureTriageEvidence } from './failure-triage.js';

export type TerminalFailureObservation = {
  readonly evidence: FailureTriageEvidence;
  readonly comparison: {
    readonly errorKind: ProviderFailureKind;
    readonly retryable: boolean;
    readonly cancelled: boolean;
    readonly observedOutcome: 'run_loop_failed' | 'cancelled';
  };
};

/** Observation-only seam. Implementations must return immediately and contain their own failures. */
export interface DecisionShadowObserver {
  observeTerminalFailure(observation: TerminalFailureObservation): void;
}
