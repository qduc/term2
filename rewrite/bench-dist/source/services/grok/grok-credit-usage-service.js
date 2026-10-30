import { fetchGrokCreditUsage, GrokCreditUsageRateLimitedError, GrokCreditUsageUnauthorizedError, } from '../../providers/grok-credit-usage.js';
/** Minimum gap between two fetches. */
export const GROK_CREDIT_USAGE_COOLDOWN_MS = 5 * 60 * 1000;
/** First backoff step after a failure, doubling up to the ceiling. */
const INITIAL_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
export class GrokCreditUsageService {
    #snapshot = { usage: null, fetchedAtMs: null };
    #listeners = new Set();
    #inFlight = null;
    /** Earliest time a fetch may run. Raised by the cooldown and by backoff. */
    #nextAllowedAtMs = 0;
    #backoffMs = INITIAL_BACKOFF_MS;
    /**
     * Set when the provider rejects our credentials. Nothing is gained by asking
     * an endpoint that has just told us the token is dead, and a stopped poller
     * is easier to reason about than one retrying in the background forever.
     */
    #stopped = false;
    #accountId = null;
    #options;
    constructor(options) {
        this.#options = options;
    }
    getSnapshot() {
        return this.#snapshot;
    }
    subscribe(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    /**
     * Fetches if the cooldown has elapsed, and does nothing otherwise.
     *
     * Never rejects: this is decoration, and a failure to read it must not reach
     * the turn that triggered it. Callers fire and forget.
     */
    async refreshIfStale({ force = false } = {}) {
        if (this.#stopped)
            return;
        if (this.#inFlight)
            return this.#inFlight;
        if (!force && this.#now() < this.#nextAllowedAtMs)
            return;
        this.#inFlight = this.#run().finally(() => {
            this.#inFlight = null;
        });
        return this.#inFlight;
    }
    /** Clears the cached value, e.g. when signing out. */
    reset() {
        this.#snapshot = { usage: null, fetchedAtMs: null };
        this.#nextAllowedAtMs = 0;
        this.#backoffMs = INITIAL_BACKOFF_MS;
        this.#stopped = false;
        this.#accountId = null;
        this.#emit();
    }
    async #run() {
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
        }
        catch (error) {
            this.#handleFailure(error);
        }
    }
    #handleFailure(error) {
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
    #dropCacheIfAccountChanged() {
        const accountId = this.#options.resolveAccountId?.() ?? null;
        if (this.#accountId !== null && accountId !== this.#accountId) {
            this.#snapshot = { usage: null, fetchedAtMs: null };
            this.#emit();
        }
        this.#accountId = accountId;
    }
    #scheduleCooldown() {
        this.#nextAllowedAtMs = this.#now() + this.#cooldownMs();
    }
    #cooldownMs() {
        return this.#options.cooldownMs ?? GROK_CREDIT_USAGE_COOLDOWN_MS;
    }
    #now() {
        return (this.#options.now ?? Date.now)();
    }
    #emit() {
        for (const listener of this.#listeners)
            listener();
    }
}
let sharedService = null;
/**
 * The process-wide instance. Sharing it is what makes the cooldown hold across
 * concurrent sessions and subagents.
 */
export const getGrokCreditUsageService = (options) => {
    sharedService ??= new GrokCreditUsageService(options);
    return sharedService;
};
/** Test seam: drops the process-wide instance. */
export const resetGrokCreditUsageServiceForTests = () => {
    sharedService = null;
};
//# sourceMappingURL=grok-credit-usage-service.js.map