import { buildFailureObservation } from './failure-observation.js';
import type { FailureTriageEvidence, FailureTriagePrediction } from './failure-triage.js';

export type FailureTriageReplayFixture = {
  readonly id: string;
  readonly evidence: FailureTriageEvidence;
  readonly expected: Pick<FailureTriagePrediction, 'category' | 'retry'>;
};

export const FAILURE_TRIAGE_REPLAY_FIXTURES: readonly FailureTriageReplayFixture[] = [
  {
    id: 'failure-triage-v2-rate-limit',
    evidence: buildFailureObservation(
      Object.assign(new Error('Provider returned HTTP 429 with retry-after.'), { status: 429, retryAfterMs: 2000 }),
      {
        requestId: 'replay-failure-1',
        provider: 'openrouter',
        model: 'fixture-model',
        tier: 'standard',
      },
    ).evidence,
    expected: { category: 'TRANSIENT_PROVIDER', retry: 'RETRY' },
  },
];
