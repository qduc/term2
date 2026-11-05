/** Accepted compaction lifecycle projection. Estimates and request evidence are
 * public audit data, never a second accounting or a synthesized outcome. */
import type { DirectCompactionFact } from '../session/facts.js';
import type {
  WireCompactionCompleted,
  WireCompactionEstimate,
  WireCompactionFailed,
  WireCompactionFailure,
  WireCompactionRequest,
  WireCompactionStarted,
} from './wire.js';

type Started = Extract<DirectCompactionFact, { readonly type: 'compaction_started' }>;
type Completed = Extract<DirectCompactionFact, { readonly type: 'compaction_completed' }>;
type Failed = Extract<DirectCompactionFact, { readonly type: 'compaction_failed' }>;

function estimate(value: Started['before']): WireCompactionEstimate {
  return {
    renderedInputTokens: value.renderedInputTokens,
    outputReserveTokens: value.outputReserveTokens,
    safetyReserveTokens: value.safetyReserveTokens,
    hardFitTokens: value.hardFitTokens,
  };
}

function request(value: Completed['requests'][number]): WireCompactionRequest {
  return {
    requestId: value.requestId,
    modelStep: value.modelStep,
    model: { provider: value.model.provider, model: value.model.model },
    outcome: value.outcome,
    ...(value.usage !== undefined
      ? {
          usage: {
            inputTokens: value.usage.inputTokens,
            outputTokens: value.usage.outputTokens,
            cachedInputTokens: value.usage.cachedInputTokens,
          },
        }
      : {}),
    ...(value.costUsd !== undefined ? { costUsd: value.costUsd } : {}),
  };
}

function failure(value: Failed['failure']): WireCompactionFailure {
  switch (value.kind) {
    case 'blocked':
      return { kind: 'blocked', reason: value.reason };
    case 'interrupted':
      return { kind: 'interrupted', reason: value.reason };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'failed':
      return {
        kind: 'failed',
        error: {
          kind: value.error.kind,
          message: value.error.message,
          ...(value.error.retryable !== undefined ? { retryable: value.error.retryable } : {}),
          ...(value.error.retryAfterMs !== undefined ? { retryAfterMs: value.error.retryAfterMs } : {}),
        },
      };
  }
}

export function publicCompactionStarted(fact: Started): WireCompactionStarted {
  return {
    compactionId: fact.compactionId,
    trigger: fact.trigger,
    model: { provider: fact.model.provider, model: fact.model.model },
    before: estimate(fact.before),
    ...(fact.strategy !== undefined ? { strategy: fact.strategy } : {}),
    ...(fact.contextWindow !== undefined ? { contextWindow: fact.contextWindow } : {}),
    ...(fact.maxRequestInputTokens !== undefined ? { maxRequestInputTokens: fact.maxRequestInputTokens } : {}),
    ...(fact.lastCompletedInputTokens !== undefined ? { lastCompletedInputTokens: fact.lastCompletedInputTokens } : {}),
  };
}

export function publicCompactionCompleted(fact: Completed): WireCompactionCompleted {
  return {
    compactionId: fact.compactionId,
    strategy: fact.strategy,
    after: estimate(fact.after),
    durationMs: fact.durationMs,
    requests: fact.requests.map(request),
  };
}

export function publicCompactionFailed(fact: Failed): WireCompactionFailed {
  return {
    compactionId: fact.compactionId,
    failure: failure(fact.failure),
    durationMs: fact.durationMs,
    requests: fact.requests.map(request),
  };
}
