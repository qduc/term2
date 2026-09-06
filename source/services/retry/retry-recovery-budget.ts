/**
 * One bounded capability shared by provider transport retries and session
 * recovery. The owner is deliberately the retry/session layer: providers can
 * consume claims, but cannot extend or reset the envelope.
 */
export const RETRY_RECOVERY_LIMITS = {
  maxRecoveryTimeMs: 90_000,
  maxPhysicalAttempts: 3,
  maxAutomaticReplays: 1,
} as const;

export type RetryRecoveryBudgetOptions = {
  now?: () => number;
  maxRecoveryTimeMs?: number;
  maxPhysicalAttempts?: number;
  maxAutomaticReplays?: number;
};

export type RetryRecoveryBudgetSnapshot = {
  physicalAttempts: number;
  maxPhysicalAttempts: number;
  automaticReplays: number;
  maxAutomaticReplays: number;
  elapsedMs: number;
  maxRecoveryTimeMs: number;
  deadlineExceeded: boolean;
};

export type RetryRecoveryAdmission = RetryRecoveryBudgetSnapshot & {
  automaticReplayRequired: boolean;
  automaticReplayAllowed: boolean;
  physicalAttemptAllowed: boolean;
  admitted: boolean;
};

export class RetryRecoveryBudget {
  readonly maxRecoveryTimeMs: number;
  readonly maxPhysicalAttempts: number;
  readonly maxAutomaticReplays: number;
  readonly #now: () => number;
  #startedAt: number | undefined;
  #physicalAttempts = 0;
  #automaticReplays = 0;

  constructor(options: RetryRecoveryBudgetOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.maxRecoveryTimeMs = options.maxRecoveryTimeMs ?? RETRY_RECOVERY_LIMITS.maxRecoveryTimeMs;
    this.maxPhysicalAttempts = options.maxPhysicalAttempts ?? RETRY_RECOVERY_LIMITS.maxPhysicalAttempts;
    this.maxAutomaticReplays = options.maxAutomaticReplays ?? RETRY_RECOVERY_LIMITS.maxAutomaticReplays;
  }

  get startedAt(): number | undefined {
    return this.#startedAt;
  }

  get physicalAttempts(): number {
    return this.#physicalAttempts;
  }

  get automaticReplays(): number {
    return this.#automaticReplays;
  }

  get elapsedMs(): number {
    return this.#startedAt === undefined ? 0 : Math.max(0, this.#now() - this.#startedAt);
  }

  /** Starts the recovery clock only after a retryable failure is observed. */
  noteRetryableFailure(): void {
    if (this.#startedAt === undefined) this.#startedAt = this.#now();
  }

  get deadlineExceeded(): boolean {
    return this.#startedAt !== undefined && this.elapsedMs >= this.maxRecoveryTimeMs;
  }

  /**
   * Return the complete non-secret state used by a recovery admission gate.
   * Recovery decisions are otherwise difficult to explain from logs because
   * claims mutate the counters before the next dispatch is made.
   */
  describeAdmission(options: { automaticReplayRequired: boolean }): RetryRecoveryAdmission {
    const elapsedMs = this.elapsedMs;
    const snapshot: RetryRecoveryBudgetSnapshot = {
      physicalAttempts: this.physicalAttempts,
      maxPhysicalAttempts: this.maxPhysicalAttempts,
      automaticReplays: this.automaticReplays,
      maxAutomaticReplays: this.maxAutomaticReplays,
      elapsedMs,
      maxRecoveryTimeMs: this.maxRecoveryTimeMs,
      deadlineExceeded: this.#startedAt !== undefined && elapsedMs >= this.maxRecoveryTimeMs,
    };
    const physicalAttemptAllowed =
      snapshot.physicalAttempts < snapshot.maxPhysicalAttempts && !snapshot.deadlineExceeded;
    const automaticReplayAllowed =
      snapshot.automaticReplays < snapshot.maxAutomaticReplays && !snapshot.deadlineExceeded;
    return {
      ...snapshot,
      automaticReplayRequired: options.automaticReplayRequired,
      automaticReplayAllowed,
      physicalAttemptAllowed,
      admitted: physicalAttemptAllowed && (!options.automaticReplayRequired || automaticReplayAllowed),
    };
  }

  /**
   * Claim one physical dispatch made because recovery is in progress.
   * Ordinary first attempts and successful tool-loop continuations are not
   * recovery work; their callers must not spend this budget on them.
   */
  claimPhysicalAttempt(): boolean {
    if (this.#physicalAttempts >= this.maxPhysicalAttempts || this.deadlineExceeded) return false;
    this.#physicalAttempts++;
    return true;
  }

  /** Claim exactly once before an automatic full-history turn replay. */
  claimAutomaticReplay(): boolean {
    if (this.#automaticReplays >= this.maxAutomaticReplays || this.deadlineExceeded) return false;
    this.#automaticReplays++;
    return true;
  }

  remainingMs(): number | undefined {
    if (this.#startedAt === undefined) return undefined;
    return Math.max(0, this.maxRecoveryTimeMs - this.elapsedMs);
  }
}

/**
 * Raised when a provider wrapper tried to start another physical request after
 * the shared recovery envelope was exhausted. Keeping the triggering failure
 * as a cause lets the classifier retain its useful provider/status details
 * without making the budget error itself look like a new provider failure.
 */
export class RetryRecoveryBudgetExhaustedError extends Error {
  readonly cause: unknown;

  constructor(cause?: unknown) {
    super('Retry recovery budget exhausted', { cause });
    this.name = 'RetryRecoveryBudgetExhaustedError';
    this.cause = cause;
  }
}

export const isRetryRecoveryBudgetExhaustedError = (error: unknown): error is RetryRecoveryBudgetExhaustedError =>
  error instanceof RetryRecoveryBudgetExhaustedError;
