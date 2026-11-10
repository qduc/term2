/** Live provider failures. Only the portable ModelError fields belong in facts. */
import type { ModelCapabilities, ModelError } from './index.js';
import { describeError, isAbortLikeError } from './error-helpers.js';
import {
  isMissingServerToolOutputError,
  isNetworkProtocolError,
  isPreviousResponseNotFoundError,
  isRecoverableIncompleteStreamClose,
  isRetryableTransportError,
} from './failure/retry-error-classification.js';
import {
  isMissingChainedToolOutputError,
  isOrphanedChainedToolOutputError,
} from '../shared/lib/chained-input-filter.js';
import { classifyUpstreamRetryableError } from './failure/upstream-retry-policy.js';
import { decideRecoverableModelRetry } from './failure/conversation-retry-policy.js';
import { findReauthenticationRequiredError } from './providers/common/provider-errors.js';
import { UnsentWebSocketRequestError } from './providers/websocket-request-dispatch.js';
import { findWebSocketClosedEarly } from './providers/websocket-close-evidence.js';
import { AmbiguousModelOutcomeError } from './failure/retry-errors.js';
import { isRetryRecoveryBudgetExhaustedError } from './failure/retry-recovery-budget.js';

/** Legacy's ProviderContextOverflowError text (src/engine/agent-runtime/request-input-limit.ts). */
const PROVIDER_CONTEXT_OVERFLOW =
  'Provider rejected context capacity. Work is retained. Compact or choose a model with verified larger capacity before resuming.';

import { ModelFailure, type ModelRecoveryEvidence } from '@qduc/agent-core';
export { ModelFailure, type ModelRecoveryEvidence } from '@qduc/agent-core';

export type FailureScope = {
  readonly capabilities: ModelCapabilities;
  readonly websocket: boolean;
  readonly flex: boolean;
};

/** Classify at the provider boundary while raw errors still retain their types. */
export function toModelFailure(error: unknown, signal?: AbortSignal, scope?: FailureScope): ModelFailure {
  if (error instanceof ModelFailure && !signal?.aborted) return error;
  const upstream = classifyUpstreamRetryableError(error);
  const status = upstream.status ?? statusOf(error);
  const rawMessage = isModelError(error) ? error.message : describeError(error);
  let message = rawMessage;
  try {
    const parsed: unknown = JSON.parse(rawMessage);
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const detail = parsed.error;
      if (detail && typeof detail === 'object' && 'message' in detail && typeof detail.message === 'string')
        message = detail.message;
    }
  } catch {
    // Non-JSON provider errors are already human-readable.
  }
  const reauthentication = findReauthenticationRequiredError(error);
  const kind: ModelError['kind'] =
    signal?.aborted || isAbortLikeError(error)
      ? 'cancelled'
      : reauthentication || status === 401 || status === 403
      ? 'authentication'
      : isModelError(error)
      ? error.kind
      : status === 429
      ? 'rate_limit'
      : isProviderContextOverflow(error)
      ? 'context_overflow'
      : [400, 404, 413, 422].includes(status ?? 0)
      ? 'invalid_request'
      : isNetworkProtocolError(error) || isConnectionError(error)
      ? 'network'
      : 'provider';
  const exhausted = isRetryRecoveryBudgetExhaustedError(error);
  const retryable =
    !exhausted &&
    !['cancelled', 'authentication', 'context_overflow', 'invalid_request'].includes(kind) &&
    (isModelError(error) ? error.retryable : upstream.retryable || isNetworkProtocolError(error));
  const portable: ModelError = {
    kind,
    // Legacy replaces the provider's capacity text with its own recovery sentence.
    message:
      kind === 'context_overflow'
        ? `provider_context_overflow: ${isModelError(error) ? message : PROVIDER_CONTEXT_OVERFLOW}`
        : message,
    retryable,
    ...(upstream.retryAfterMs !== undefined
      ? { retryAfterMs: upstream.retryAfterMs }
      : isModelError(error) && error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
  if (exhausted || kind === 'cancelled' || kind === 'authentication' || kind === 'context_overflow')
    return new ModelFailure(portable, error);
  const typed = typedDispatchFailure(error);
  const evidence = recoveryEvidence(error, typed, scope, status);
  return new ModelFailure(portable, typed ?? error, evidence);
}

function recoveryEvidence(
  error: unknown,
  typed: Error | undefined,
  scope?: FailureScope,
  status?: number,
): ModelRecoveryEvidence | undefined {
  if (typed instanceof UnsentWebSocketRequestError) return 'request_unsent';
  if (
    isPreviousResponseNotFoundError(error) ||
    isMissingServerToolOutputError(error) ||
    isMissingChainedToolOutputError(error) ||
    isOrphanedChainedToolOutputError(error)
  )
    return 'provider_state_rejected';
  const closed = findWebSocketClosedEarly(error);
  if (
    isRecoverableIncompleteStreamClose(error) ||
    (closed && (closed.closeCode === undefined || [1000, 1001, 1006, 1011, 1012, 1013].includes(closed.closeCode)))
  )
    return 'connection_interrupted';
  if (typed instanceof AmbiguousModelOutcomeError) return 'ambiguous_outcome';
  if (decideRecoverableModelRetry(error, 0).kind === 'retry') return 'model_behavior';
  if (scope?.capabilities.standardServiceTier && scope.flex && status === 503) return 'service_tier_rejected';
  if (
    scope?.capabilities.httpTransportDowngrade &&
    scope.websocket &&
    isRetryableTransportError(error).transportFallback
  ) {
    return 'transport_downgrade';
  }
  return undefined;
}

/** Preserve the nearest actual typed dispatch failure through SDK cause wrappers. */
function typedDispatchFailure(error: unknown): Error | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    if (current instanceof UnsentWebSocketRequestError || current instanceof AmbiguousModelOutcomeError) return current;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function statusOf(error: unknown): number | undefined {
  const value = error as { status?: unknown; statusCode?: unknown } | null;
  const status = value?.status ?? value?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

function isConnectionError(error: unknown): boolean {
  const value = error as { name?: unknown; code?: unknown } | null;
  return (
    value?.name === 'APIConnectionError' ||
    value?.name === 'APIConnectionTimeoutError' ||
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(String(value?.code))
  );
}

function isModelError(error: unknown): error is ModelError {
  const value = error as Partial<ModelError> | null;
  return (
    !!value &&
    [
      'authentication',
      'rate_limit',
      'network',
      'context_overflow',
      'invalid_request',
      'provider',
      'cancelled',
    ].includes(value.kind ?? '') &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean'
  );
}

/** Native provider-boundary classification; do not depend on legacy engine admission. */
function isProviderContextOverflow(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const value = current as { code?: unknown; error?: { code?: unknown }; responseBody?: unknown; cause?: unknown };
    let body: { code?: unknown; error?: { code?: unknown } } | undefined;
    if (typeof value.responseBody === 'string' && value.responseBody.length < 100000) {
      try {
        body = JSON.parse(value.responseBody) ?? undefined;
      } catch {
        // A non-JSON body is not structured capacity evidence.
      }
    }
    if (
      [value.code, value.error?.code, body?.code, body?.error?.code].some((code) =>
        [
          'provider_context_overflow',
          'context_length_exceeded',
          'context_window_exceeded',
          'max_context_length_exceeded',
          'prompt_too_long',
          'input_too_long',
        ].includes(code as string),
      )
    )
      return true;
    current = value.cause;
  }
  return false;
}
