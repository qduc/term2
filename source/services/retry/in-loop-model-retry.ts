import {
  isMissingServerToolOutputError,
  isPreviousResponseNotFoundError,
  isRecoverableIncompleteStreamClose,
  isWebSocketConnectionLimitReachedError,
} from './retry-error-classification.js';
import { classifyUpstreamRetryableError } from './upstream-retry-policy.js';
import { AmbiguousModelOutcomeError, ConversationStateNoProgressError } from './retry-errors.js';
import { findReauthenticationRequiredError } from '../../providers/common/provider-errors.js';
import { findWebSocketClosedEarly } from '../../providers/websocket-close-evidence.js';
import { isCancellationError } from '../../lib/harness-invariant-error.js';
import { GenerationGuardError } from '../agent-runtime/generation-guard.js';

const TRANSIENT_BASE_DELAY_MS = 500;
const TRANSIENT_MAX_DELAY_MS = 30_000;

const RETRYABLE_WEBSOCKET_CLOSE_CODES = new Set([
  '1001', // Going Away
  '1006', // Abnormal Close
  '1011', // Internal Error
  '1012', // Service Restart
  '1013', // Try Again Later
]);

export type InLoopRetryDecision =
  | {
      readonly retryable: true;
      readonly kind: 'chain_recovery';
      readonly delayMs: number;
    }
  | {
      readonly retryable: false;
      readonly reason: string;
    };

export function computeInLoopBackoffDelayMs(
  attempt: number,
  random: () => number = Math.random,
  upstreamDelayMs?: number,
): number {
  if (typeof upstreamDelayMs === 'number' && upstreamDelayMs > 0) {
    return upstreamDelayMs;
  }
  const baseDelay = Math.min(TRANSIENT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), TRANSIENT_MAX_DELAY_MS);
  const jitter = 0.9 + random() * 0.2;
  return Math.round(baseDelay * jitter);
}

export function classifyInLoopModelRetry(
  error: unknown,
  attempt: number,
  maxRetries: number,
  random: () => number = Math.random,
): InLoopRetryDecision {
  if (attempt >= maxRetries) {
    return { retryable: false, reason: 'max_retries_exceeded' };
  }

  if (!error) {
    return { retryable: false, reason: 'unknown_error' };
  }

  if (isCancellationError(error) || (error instanceof Error && error.name === 'AbortError')) {
    return { retryable: false, reason: 'aborted' };
  }

  if (error instanceof GenerationGuardError) {
    return { retryable: false, reason: 'generation_guard' };
  }

  if (error instanceof ConversationStateNoProgressError) {
    return { retryable: false, reason: 'no_progress' };
  }

  if (findReauthenticationRequiredError(error)) {
    return { retryable: false, reason: 'reauthentication_required' };
  }

  const upstream = classifyUpstreamRetryableError(error);
  const upstreamDelay = upstream.retryAfterMs;
  const recoverChain = (): InLoopRetryDecision => ({
    retryable: true,
    kind: 'chain_recovery',
    delayMs: computeInLoopBackoffDelayMs(attempt + 1, random, upstreamDelay),
  });

  const wsClosed = findWebSocketClosedEarly(error);
  if (wsClosed) {
    const code = wsClosed.closeCode !== undefined ? String(wsClosed.closeCode) : undefined;
    const isRetryable = code ? RETRYABLE_WEBSOCKET_CLOSE_CODES.has(code) : true;
    if (isRetryable) {
      return recoverChain();
    }
    return { retryable: false, reason: 'websocket_close_non_retryable' };
  }

  if (isPreviousResponseNotFoundError(error) || isMissingServerToolOutputError(error)) {
    return recoverChain();
  }

  if (error instanceof AmbiguousModelOutcomeError) {
    if (isRecoverableIncompleteStreamClose(error)) {
      return recoverChain();
    }
    return { retryable: false, reason: 'ambiguous_outcome' };
  }

  if (isWebSocketConnectionLimitReachedError(error)) {
    return recoverChain();
  }

  if (isRecoverableIncompleteStreamClose(error)) {
    return recoverChain();
  }

  const errorString = String((error as { message?: unknown })?.message ?? error).toLowerCase();
  const isConnectionDrop =
    errorString.includes('websocket') ||
    errorString.includes('socket hang up') ||
    errorString.includes('connection error') ||
    errorString.includes('connection reset') ||
    errorString.includes('econnreset') ||
    errorString.includes('etimedout');

  if (isConnectionDrop) {
    return recoverChain();
  }

  return { retryable: false, reason: 'unrecoverable' };
}

export async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) {
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    throw abortError;
  }

  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined = undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      const abortError = new Error('The operation was aborted.');
      abortError.name = 'AbortError';
      reject(abortError);
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);
  });
}
