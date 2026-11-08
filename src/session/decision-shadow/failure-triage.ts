import type { ServiceTier } from '../../shared/cost/model-cost.js';

export type FailureTriageEvidence = {
  readonly requestId: string;
  readonly provider?: string;
  readonly model: string;
  readonly tier: ServiceTier;
  readonly status?: number;
  readonly code?: string;
  readonly retryAfterMs?: number;
  readonly message: string;
  readonly transport: { readonly errorName?: string; readonly causeName?: string };
};
