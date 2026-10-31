/** Recovery admission only: the direct engine remains the sole request driver. */
import type { ModelError } from '../model/index.js';
import {
  RetryRecoveryBudget,
  type RetryRecoveryAdmission,
} from '../../../source/services/retry/retry-recovery-budget.js';
import {
  AmbiguousModelOutcomeError,
  getZeroFrameAmbiguousTimeout,
} from '../../../source/services/retry/retry-errors.js';

export { RetryRecoveryBudget };
export type { RetryRecoveryAdmission };

/** Evidence must come from the model adapter, not message/timeout wording. */
export type DirectRecoveryFailure = {
  readonly error: ModelError;
  readonly cause?: unknown;
  readonly evidence?:
    | 'request_unsent'
    | 'provider_state_rejected'
    | 'connection_interrupted'
    | 'ambiguous_outcome'
    | 'model_behavior'
    | 'service_tier_rejected'
    | 'transport_downgrade';
};

export type DirectRecoveryContext = {
  readonly failure: DirectRecoveryFailure;
  readonly cancelled: boolean;
  /** False if the local transcript cannot form a self-contained request. */
  readonly fullHistoryAvailable: boolean;
  readonly freshStartAllowed: boolean;
  /** Any accepted model output/effect in this logical turn (not bookkeeping). */
  readonly hasCommittedOutput: boolean;
  readonly tools: {
    readonly completed: number;
    readonly allCompleted: boolean;
    readonly completedPairsInHistory: boolean;
  };
};

export type DirectRecoveryDecision =
  | {
      readonly kind: 'stop';
      readonly reason:
        | 'cancelled'
        | 'unrecoverable'
        | 'history_unavailable'
        | 'unsettled_tools'
        | 'committed_output'
        | 'fresh_start_forbidden'
        | 'retry_limit'
        | 'recovery_budget';
      readonly admission?: RetryRecoveryAdmission;
    }
  | {
      readonly kind: 'retry';
      readonly recovery: 'transient' | 'chain' | 'model_behavior' | 'service_tier' | 'transport';
      readonly attempt: number;
      readonly delayMs: number;
      readonly inputMode: 'full_history' | 'delta';
      readonly disableChaining: boolean;
      readonly useStandardServiceTier: boolean;
      readonly downgradeTransport: boolean;
      readonly automaticReplay: boolean;
      /** The next dispatch is already charged; adapters must not charge it twice. */
      readonly dispatchClaimed: true;
      readonly admission: RetryRecoveryAdmission;
    };

type RecoveryKind = Extract<DirectRecoveryDecision, { kind: 'retry' }>['recovery'];
type RecoveryChoice =
  | { kind: 'transient'; automaticReplay: false }
  | { kind: Exclude<RecoveryKind, 'transient'>; automaticReplay: boolean };

export type DirectRecoveryOptions = {
  readonly maxTransientRetries: number;
  readonly maxModelRetries?: number;
  readonly budget?: RetryRecoveryBudget;
  readonly random?: () => number;
};

/**
 * One instance per logical run, shared across tool-loop model requests. Only an
 * accepted terminal model response ends the recovery-budget episode. No timer
 * aborts healthy work: the 90s budget measures recovery overhead, not run time.
 * `recover` reserves the next physical dispatch; call once per failed request.
 */
export class DirectRecovery {
  readonly budget: RetryRecoveryBudget;
  readonly #options: DirectRecoveryOptions;
  #transientRetries = 0;
  #modelRetries = 0;
  #tierFallbacks = 0;
  #transportDowngrades = 0;

  constructor(options: DirectRecoveryOptions) {
    assertRetryCount(options.maxTransientRetries);
    assertRetryCount(options.maxModelRetries ?? 2);
    this.#options = options;
    this.budget = options.budget ?? new RetryRecoveryBudget();
  }

  /** Call after Session has accepted the complete model response, never on a delta. */
  responseAccepted(): void {
    this.budget.noteModelResponseCompleted();
    this.#transientRetries = 0;
    this.#modelRetries = 0;
  }

  /** Classify and reserve recovery; does not edit history or re-invoke a tool. */
  recover(context: DirectRecoveryContext): DirectRecoveryDecision {
    if (context.cancelled || context.failure.error.kind === 'cancelled') return stop('cancelled');
    if (!context.fullHistoryAvailable) return stop('history_unavailable');
    if (!context.tools.allCompleted) return stop('unsettled_tools');
    const choice = chooseRecovery(context);
    if (!choice) return stop(context.hasCommittedOutput ? 'committed_output' : 'unrecoverable');
    if (choice.kind === 'transient' && !context.freshStartAllowed) return stop('fresh_start_forbidden');
    if (!this.#withinLimit(choice.kind)) return stop('retry_limit');

    this.budget.noteRetryableFailure();
    const options = { automaticReplayRequired: choice.automaticReplay };
    const admission =
      this.budget.claimZeroFrameTimeoutRecovery(context.failure.cause, {
        ...options,
        maxRetries: this.#options.maxTransientRetries,
      }) ?? this.budget.describeAdmission(options);
    if (!admission.admitted) return { ...stop('recovery_budget'), admission };
    // The typed zero-frame path atomically claimed both counters already.
    if (!getZeroFrameAmbiguousTimeout(context.failure.cause)) {
      if (choice.automaticReplay) this.budget.claimAutomaticReplay();
      this.budget.claimPhysicalAttempt();
    }
    const attempt = this.#advance(choice.kind);
    return {
      kind: 'retry',
      recovery: choice.kind,
      attempt,
      delayMs: recoveryDelay(attempt, context.failure.error.retryAfterMs, this.#options.random),
      inputMode: choice.kind === 'service_tier' ? 'delta' : 'full_history',
      disableChaining: choice.kind !== 'service_tier',
      useStandardServiceTier: choice.kind === 'service_tier',
      downgradeTransport: choice.kind === 'transport',
      automaticReplay: choice.automaticReplay,
      dispatchClaimed: true,
      admission,
    };
  }

  #withinLimit(kind: RecoveryKind): boolean {
    if (kind === 'model_behavior') return this.#modelRetries < (this.#options.maxModelRetries ?? 2);
    if (kind === 'service_tier') return this.#tierFallbacks < 1;
    if (kind === 'transport') return this.#transportDowngrades < 1;
    return this.#transientRetries < this.#options.maxTransientRetries;
  }

  #advance(kind: RecoveryKind): number {
    if (kind === 'model_behavior') return ++this.#modelRetries;
    if (kind === 'service_tier') return ++this.#tierFallbacks;
    if (kind === 'transport') return ++this.#transportDowngrades;
    return ++this.#transientRetries;
  }
}

function chooseRecovery(context: DirectRecoveryContext): RecoveryChoice | undefined {
  const { failure, tools } = context;
  const evidence = failure.evidence;
  const zeroFrame = !!getZeroFrameAmbiguousTimeout(failure.cause);
  // A refused provider-state request may be rebuilt once completed pairs have
  // been reconciled from Session's ledger, even across a compaction boundary.
  const settledContinuation =
    tools.completed > 0 && (tools.completedPairsInHistory || evidence === 'provider_state_rejected');
  const chainFailure =
    evidence === 'request_unsent' ||
    evidence === 'provider_state_rejected' ||
    evidence === 'connection_interrupted' ||
    zeroFrame;
  if (context.hasCommittedOutput) {
    return settledContinuation && chainFailure ? { kind: 'chain', automaticReplay: false } : undefined;
  }
  if ((evidence === 'ambiguous_outcome' || failure.cause instanceof AmbiguousModelOutcomeError) && !zeroFrame)
    return undefined;
  if (chainFailure) return { kind: 'chain', automaticReplay: !settledContinuation };
  if (evidence === 'model_behavior') return { kind: 'model_behavior', automaticReplay: true };
  if (evidence === 'service_tier_rejected') return { kind: 'service_tier', automaticReplay: false };
  if (evidence === 'transport_downgrade') return { kind: 'transport', automaticReplay: true };
  if (!evidence && failure.error.retryable && ['network', 'rate_limit', 'provider'].includes(failure.error.kind)) {
    // Engine-owned pre-output transport retries replace the adapter's former
    // hidden retry loop. Re-preparing full history is not a whole-turn replay:
    // spend the physical dispatch envelope, leaving the separate replay claim
    // for explicit chain/model-behavior recovery. Accepted output and ambiguous
    // outcomes have already been excluded above; no tool batch is replayed.
    return { kind: 'transient', automaticReplay: false };
  }
  return undefined;
}

/** Preserve upstream Retry-After; otherwise use the existing 500ms..30s jittered backoff. */
export function recoveryDelay(attempt: number, retryAfterMs?: number, random = Math.random): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) return retryAfterMs;
  return Math.round(Math.min(500 * 2 ** Math.max(0, attempt - 1), 30_000) * (0.9 + random() * 0.2));
}

function stop(
  reason: Extract<DirectRecoveryDecision, { kind: 'stop' }>['reason'],
): Extract<DirectRecoveryDecision, { kind: 'stop' }> {
  return { kind: 'stop', reason };
}

function assertRetryCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Retry count must be a nonnegative integer');
}
