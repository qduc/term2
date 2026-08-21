/**
 * Owns *when* Grok's credit meter is fetched, and holds the last value.
 *
 * The meter is a weekly percentage reported as an integer, so freshness is
 * worth very little: nothing a user does in five minutes moves 29% to 30% in a
 * way they can perceive. The endpoint, meanwhile, is undocumented — recovered
 * from the `grok` CLI binary rather than published — so the cost of asking too
 * often is higher than the benefit of asking again. Every policy here resolves
 * that trade the same way: ask rarely, and stop asking when told to.
 *
 * The service is shared process-wide (see `getGrokCreditUsageService`) because
 * the cooldown is only meaningful if every caller consults the same clock. A
 * fan-out of subagents finishing turns at once would otherwise each see an
 * un-elapsed cooldown of their own and all fetch together.
 */
import type { GrokCreditUsage } from '../../providers/grok-credit-usage.js';
import {
  fetchGrokCreditUsage,
  GrokCreditUsageRateLimitedError,
  GrokCreditUsageUnauthorizedError,
} from '../../providers/grok-credit-usage.js';

/** Minimum gap between two fetches. */
export const GROK_CREDIT_USAGE_COOLDOWN_MS = 5 * 60 * 1000;
/** First backoff step after a failure, doubling up to the ceiling. */
const INITIAL_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

export interface GrokCreditUsageSnapshot {
  /** The last successfully read meter, or null if we have never read one. */
  readonly usage: GrokCreditUsage | null;
  /** When `usage` was read, as epoch milliseconds. */
  readonly fetchedAtMs: number | null;
}

type Listener = () => void;

export interface GrokCreditUsageServiceOptions {
  /** Resolves the bearer token, or throws/returns null when not logged in. */
  readonly resolveAccessToken: () => Promise<string | null>;
  /** Identifies the account the token belongs to, so a switch drops the cache. */
  readonly resolveAccountId?: () => string | null;
  readonly fetchUsage?: typeof fetchGrokCreditUsage;
  readonly now?: () => number;
  readonly cooldownMs?: number;
  readonly onError?: (error: unknown) => void;
}

export class GrokCreditUsageService {
  #snapshot: GrokCreditUsageSnapshot = { usage: null, fetchedAtMs: null };
  #listeners = new Set<Listener>();
  #inFlight: Promise<void> | null = null;
  /** Earliest time a fetch may run. Raised by the cooldown and by backoff. */
  #nextAllowedAtMs = 0;
  #backoffMs = INITIAL_BACKOFF_MS;
  /**
   * Set when the provider rejects our credentials. Nothing is gained by asking
   * an endpoint that has just told us the token is dead, and a stopped poller
   * is easier to reason about than one retrying in the background forever.
   */
  #stopped = false;
  #accountId: string | null = null;

  readonly #options: Required<Pick<GrokCreditUsageServiceOptions, 'resolveAccessToken'>> &
    GrokCreditUsageServiceOptions;

  constructor(options: GrokCreditUsageServiceOptions) {
    this.#options = options;
  }

  getSnapshot(): GrokCreditUsageSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Fetches if the cooldown has elapsed, and does nothing otherwise.
   *
   * Never rejects: this is decoration, and a failure to read it must not reach
   * the turn that triggered it. Callers fire and forget.
   */
  async refreshIfStale({ force = false }: { force?: boolean } = {}): Promise<void> {
    if (this.#stopped) return;
    if (this.#inFlight) return this.#inFlight;
    if (!force && this.#now() < this.#nextAllowedAtMs) return;

    this.#inFlight = this.#run().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  /** Clears the cached value, e.g. when signing out. */
  reset(): void {
    this.#snapshot = { usage: null, fetchedAtMs: null };
    this.#nextAllowedAtMs = 0;
    this.#backoffMs = INITIAL_BACKOFF_MS;
    this.#stopped = false;
    this.#accountId = null;
    this.#emit();
  }

  async #run(): Promise<void> {
    try {
      const accessToken = await this.#options.resolveAccessToken();
      if (!accessToken) {
        // Not logged in yet. Not an error, and not a reason to stop: a login
        // can happen later in the same session.
        this.#scheduleCooldown();
        return;
      }

      this.#dropCacheIfAccountChanged();

      const fetchUsage = this.#options.fetchUsage ?? fetchGrokCreditUsage;
      const usage = await fetchUsage({ accessToken });

      this.#backoffMs = INITIAL_BACKOFF_MS;
      this.#scheduleCooldown();
      // A well-formed response with no meter leaves the previous value alone
      // rather than blanking the display.
      if (usage) {
        this.#snapshot = { usage, fetchedAtMs: this.#now() };
        this.#emit();
      }
    } catch (error) {
      this.#handleFailure(error);
    }
  }

  #handleFailure(error: unknown): void {
    this.#options.onError?.(error);

    if (error instanceof GrokCreditUsageUnauthorizedError) {
      this.#stopped = true;
      return;
    }

    if (error instanceof GrokCreditUsageRateLimitedError && error.retryAfterMs !== undefined) {
      this.#nextAllowedAtMs = this.#now() + Math.max(error.retryAfterMs, this.#cooldownMs());
      return;
    }

    this.#nextAllowedAtMs = this.#now() + this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, MAX_BACKOFF_MS);
  }

  /**
   * The meter is per-account, and a session pins the account it first resolved.
   * Should the resolved account change anyway, the previous account's number is
   * wrong rather than stale, so it is dropped instead of shown.
   */
  #dropCacheIfAccountChanged(): void {
    const accountId = this.#options.resolveAccountId?.() ?? null;
    if (this.#accountId !== null && accountId !== this.#accountId) {
      this.#snapshot = { usage: null, fetchedAtMs: null };
      this.#emit();
    }
    this.#accountId = accountId;
  }

  #scheduleCooldown(): void {
    this.#nextAllowedAtMs = this.#now() + this.#cooldownMs();
  }

  #cooldownMs(): number {
    return this.#options.cooldownMs ?? GROK_CREDIT_USAGE_COOLDOWN_MS;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

let sharedService: GrokCreditUsageService | null = null;

/**
 * The process-wide instance. Sharing it is what makes the cooldown hold across
 * concurrent sessions and subagents.
 */
export const getGrokCreditUsageService = (options: GrokCreditUsageServiceOptions): GrokCreditUsageService => {
  sharedService ??= new GrokCreditUsageService(options);
  return sharedService;
};

/** Test seam: drops the process-wide instance. */
export const resetGrokCreditUsageServiceForTests = (): void => {
  sharedService = null;
};
