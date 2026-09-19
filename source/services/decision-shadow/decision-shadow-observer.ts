import type { ToolRegistry } from '../../tools/types.js';
import type { ServiceTier } from '../cost/model-cost.js';
import type { ProviderFailureKind } from '../retry/provider-failure-classification.js';
import type { FailureTriageEvidence } from './failure-triage.js';

export type ToolSelectionRequestObservation = {
  readonly requestId: string;
  readonly provider?: string;
  readonly model: string;
  readonly tier: ServiceTier;
  readonly chaining: boolean;
  readonly input: readonly unknown[];
  readonly tools: ToolRegistry;
};

export type ToolSelectionOutcomeObservation = {
  readonly requestId: string;
  readonly outcome: 'tools' | 'text_only' | 'failed' | 'cancelled' | 'retried';
  readonly selections: readonly { readonly name: string; readonly callPath: 'direct' | 'run_code' }[];
};

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
  observeToolSelectionRequest(observation: ToolSelectionRequestObservation): void;
  observeToolSelectionOutcome(observation: ToolSelectionOutcomeObservation): void;
  observeTerminalFailure(observation: TerminalFailureObservation): void;
}
