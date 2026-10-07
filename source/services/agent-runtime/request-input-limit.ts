import { resolveModelContextPolicy } from './model-context-policy.js';
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
    readonly reason: 'ceiling_exceeded' | 'unobservable_chained_context' | 'capacity_exceeded' = 'ceiling_exceeded',
    readonly capacity?: number,
    readonly outputReserve?: number,
    readonly estimationReserve?: number,
  ) {
    super(
      reason === 'unobservable_chained_context'
        ? 'Cannot enforce the active input bound on an unobserved provider chain. Work is retained. Resume with a full history snapshot so the selected model capacity can be checked.'
        : reason === 'capacity_exceeded'
        ? `Request cannot fit the known model capacity (input budget ${limit}, output reserve ${outputReserve}, estimation reserve ${estimationReserve}, capacity ${capacity}). Work is retained. Compact, choose a larger-capacity model, or lower an explicit output allocation before resuming.`
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
  contextWindow?: number;
  maxOutputTokens?: number;
  history: readonly ProviderInputItem[];
  instructions: string;
  tools: unknown;
  lastCompletedInputTokens?: number;
  chainedContextKnown?: boolean;
}): void {
  if (input.limit != null && (!Number.isSafeInteger(input.limit) || input.limit < 1_000))
    throw new RangeError('maxRequestInputTokens must be null or an integer >=1000');
  const policy = resolveModelContextPolicy({
    contextWindow: input.contextWindow,
    maxOutputTokens: input.maxOutputTokens,
    inputLimit: input.limit,
  });
  const limit = policy.hardInputLimit;
  if (limit === undefined) return;
  const estimatedTokens = estimateContext(input).renderedInputTokens;
  const observedTokens = input.lastCompletedInputTokens ?? 0;
  if (input.chainedContextKnown === false) {
    throw new RequestInputLimitError(limit, estimatedTokens, observedTokens, 'unobservable_chained_context');
  }
  if (Math.max(estimatedTokens, observedTokens) > limit) {
    throw new RequestInputLimitError(
      limit,
      estimatedTokens,
      observedTokens,
      policy.limitSource === 'model_capacity' ? 'capacity_exceeded' : 'ceiling_exceeded',
      policy.capacity,
      policy.outputReserve,
      policy.estimationReserve,
    );
  }
}

export class ProviderContextOverflowError extends Error {
  readonly code = 'provider_context_overflow';
  constructor(cause: unknown) {
    super(
      'Provider rejected context capacity. Work is retained. Compact or choose a model with verified larger capacity before resuming.',
      { cause },
    );
    this.name = 'ProviderContextOverflowError';
  }
}
/** Structured provider evidence only; no message-substring size guesses. */
export function isProviderContextOverflow(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: any = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    let body: any;
    if (typeof current.responseBody === 'string' && current.responseBody.length < 100000) {
      try {
        body = JSON.parse(current.responseBody);
      } catch {
        // Non-JSON provider bodies are not structured capacity evidence.
      }
    }
    const codes = [current.code, current.error?.code, body?.code, body?.error?.code];
    if (
      codes.some((code) =>
        [
          'provider_context_overflow',
          'context_length_exceeded',
          'context_window_exceeded',
          'max_context_length_exceeded',
          'prompt_too_long',
          'input_too_long',
        ].includes(code),
      )
    )
      return true;
    current = current.cause;
  }
  return false;
}
