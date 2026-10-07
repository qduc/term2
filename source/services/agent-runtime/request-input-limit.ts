import type { ProviderInputItem } from '../../contracts/provider-input.js';
import { estimateContext } from './context-compaction/index.js';

/** Admission refusal: no provider dispatch, no retry, and no transcript truncation. */
export class RequestInputLimitError extends Error {
  readonly code = 'request_input_limit';
  readonly action = 'reject_before_dispatch';
  constructor(
    readonly limit: number,
    readonly estimatedTokens: number,
    readonly observedTokens: number,
    readonly reason: 'ceiling_exceeded' | 'unobservable_chained_context' = 'ceiling_exceeded',
  ) {
    super(
      reason === 'unobservable_chained_context'
        ? 'Cannot enforce the configured input ceiling on an unobserved provider chain. Work is retained. Resume with a full history snapshot or explicitly change agent.maxRequestInputTokens.'
        : `Request input exceeds configured ceiling (${Math.max(
            estimatedTokens,
            observedTokens,
          )} > ${limit} tokens). Work is retained. Compact, use a concise artifact-backed handoff, or explicitly raise agent.maxRequestInputTokens before resuming.`,
    );
    this.name = 'RequestInputLimitError';
  }
}

export function enforceRequestInputLimit(input: {
  limit?: number | null;
  history: readonly ProviderInputItem[];
  instructions: string;
  tools: unknown;
  lastCompletedInputTokens?: number;
  chainedContextKnown?: boolean;
}): void {
  if (input.limit == null) return;
  if (!Number.isSafeInteger(input.limit) || input.limit < 1_000)
    throw new RangeError('maxRequestInputTokens must be null or an integer >=1000');
  const estimatedTokens = estimateContext(input).renderedInputTokens;
  const observedTokens = input.lastCompletedInputTokens ?? 0;
  if (input.chainedContextKnown === false) {
    throw new RequestInputLimitError(input.limit, estimatedTokens, observedTokens, 'unobservable_chained_context');
  }
  if (Math.max(estimatedTokens, observedTokens) > input.limit) {
    throw new RequestInputLimitError(input.limit, estimatedTokens, observedTokens);
  }
}
