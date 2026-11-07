/** Shared dispatch gate. Engine-owned requests never retry inside this adapter. */
import type { ModelEvent, ModelRequest } from './index.js';
import { ModelFailure, toModelFailure, type FailureScope } from './failure.js';
import { RetryRecoveryBudget, RetryRecoveryBudgetExhaustedError } from './failure/retry-recovery-budget.js';
import { computeUpstreamRetryDelayMs } from './failure/upstream-retry-policy.js';

/**
 * With injected recovery, make exactly one physical attempt: the engine must
 * run steering/request preparation again before every subsequent dispatch.
 * Never reset a shared episode on provider success (Session acceptance owns
 * that). Standalone callers without recovery retain bounded pre-output retries;
 * those use a request-local budget, not a second recovery owner for the engine.
 */
export async function* physicalModelStream(input: {
  readonly request: ModelRequest;
  readonly signal: AbortSignal;
  readonly maxRetries: number;
  readonly scope: FailureScope;
  readonly stream: () => AsyncIterable<ModelEvent>;
}): AsyncGenerator<ModelEvent, void> {
  if (!Number.isSafeInteger(input.maxRetries) || input.maxRetries < 0)
    throw new RangeError('Invalid provider retry count');
  const shared = input.request.recovery;
  const budget = shared?.budget ?? new RetryRecoveryBudget();
  const maxRetries = shared ? 0 : input.maxRetries;
  let previousFailure: ModelFailure | undefined;
  for (let attempt = 0; ; attempt++) {
    input.signal.throwIfAborted();
    const reserved = attempt === 0 && input.request.recovery?.dispatchClaimed === true;
    if (shared && budget.startedAt !== undefined && !reserved) {
      throw new ModelFailure({
        kind: 'invalid_request',
        retryable: false,
        message: 'A recovery dispatch requires the engine-owned budget reservation.',
      });
    }
    if (budget.deadlineExceeded || (!shared && attempt > 0 && !budget.claimPhysicalAttempt())) {
      throw toModelFailure(new RetryRecoveryBudgetExhaustedError(previousFailure), input.signal);
    }
    let committed = false;
    try {
      for await (const event of input.stream()) {
        input.signal.throwIfAborted();
        // A usage or item frame counts too, not just visible text. No output
        // from a failed attempt is silently retracted by this transport owner.
        committed = true;
        yield event;
      }
      return;
    } catch (error) {
      const failure = toModelFailure(error, input.signal, input.scope);
      if (committed || input.signal.aborted || !failure.retryable || failure.recoveryEvidence || attempt >= maxRetries)
        throw failure;
      previousFailure = failure;
      budget.noteRetryableFailure();
      const delayMs = computeUpstreamRetryDelayMs({ retryAfterMs: failure.retryAfterMs, attemptIndex: attempt });
      const remaining = budget.remainingMs();
      if (remaining !== undefined && delayMs > remaining) throw failure;
      yield { type: 'retrying', attempt: attempt + 1, delayMs, error: portable(failure) };
      await waitForRetry(delayMs, input.signal);
    }
  }
}

function portable(error: ModelFailure): import('./index.js').ModelError {
  return {
    kind: error.kind,
    message: error.message,
    retryable: error.retryable,
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
  };
}

/** Abort-aware backoff; no runtime timeout or polling loop. */
async function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
