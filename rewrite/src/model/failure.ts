/** Live provider failures. Only the portable ModelError fields belong in facts. */
import type { ModelCapabilities, ModelError } from './index.js';
import { describeError, isAbortLikeError } from '../../../source/utils/error-helpers.js';
import {
  isMissingServerToolOutputError,
  isNetworkProtocolError,
  isPreviousResponseNotFoundError,
  isRecoverableIncompleteStreamClose,
  isRetryableTransportError,
} from '../../../source/services/retry/retry-error-classification.js';
import {
  isMissingChainedToolOutputError,
  isOrphanedChainedToolOutputError,
} from '../../../source/lib/chained-input-filter.js';
import { classifyUpstreamRetryableError } from '../../../source/services/retry/upstream-retry-policy.js';
import { decideRecoverableModelRetry } from '../../../source/services/retry/conversation-retry-policy.js';
import { findReauthenticationRequiredError } from '../../../source/providers/common/provider-errors.js';
import { UnsentWebSocketRequestError } from '../../../source/providers/websocket-request-dispatch.js';
import { findWebSocketClosedEarly } from '../../../source/providers/websocket-close-evidence.js';
import { AmbiguousModelOutcomeError } from '../../../source/services/retry/retry-errors.js';
import { isRetryRecoveryBudgetExhaustedError } from '../../../source/services/retry/retry-recovery-budget.js';

export type ModelRecoveryEvidence =
  | 'request_unsent'
  | 'provider_state_rejected'
  | 'connection_interrupted'
  | 'ambiguous_outcome'
  | 'model_behavior'
  | 'service_tier_rejected'
  | 'transport_downgrade';

/**
 * Engine consumes cause/recoveryEvidence before serializing a terminal error.
 * Both are non-enumerable live evidence, never a persisted retry capability.
 * The cause retains actual typed send/timeout evidence, not a reconstructed Error.
 */
export class ModelFailure extends Error implements ModelError {
  readonly kind: ModelError['kind'];
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  override readonly cause: unknown;
  readonly recoveryEvidence?: ModelRecoveryEvidence;

  constructor(error: ModelError, cause?: unknown, recoveryEvidence?: ModelRecoveryEvidence) {
    super(error.message, { cause });
    this.name = 'ModelFailure';
    this.kind = error.kind;
    this.retryable = error.retryable;
    if (error.retryAfterMs !== undefined) this.retryAfterMs = error.retryAfterMs;
    Object.defineProperty(this, 'cause', { value: cause, enumerable: false });
    Object.defineProperty(this, 'recoveryEvidence', { value: recoveryEvidence, enumerable: false });
  }
}

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
  const message = isModelError(error) ? error.message : describeError(error);
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
      : (status === 400 || status === 413) && /context[ _](length|window)|too many tokens/i.test(message)
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
    message,
    retryable,
    ...(upstream.retryAfterMs !== undefined
      ? { retryAfterMs: upstream.retryAfterMs }
      : isModelError(error) && error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
  if (exhausted || kind === 'cancelled' || kind === 'authentication') return new ModelFailure(portable, error);
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
