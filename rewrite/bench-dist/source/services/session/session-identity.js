/**
 * Identity shared by the retained session graph. An internal context rollover
 * moves the current conversation/persistence identity while the public process
 * session identity remains fixed; an explicit new-session action constructs a
 * new instance.
 */
export class SessionIdentity {
    #value;
    #startedAt;
    #publicId;
    #publicStartedAt;
    #promptCacheKey;
    constructor(value, startedAt = new Date().toISOString(), promptCacheKey = value) {
        this.#value = value;
        this.#startedAt = startedAt;
        this.#publicId = value;
        this.#publicStartedAt = startedAt;
        this.#promptCacheKey = promptCacheKey;
    }
    /** Stable external session identity for the lifetime of this retained graph. */
    get publicId() {
        return this.#publicId;
    }
    get publicStartedAt() {
        return this.#publicStartedAt;
    }
    /** Current persisted conversation identity; changes on internal context rollover. */
    get current() {
        return this.#value;
    }
    get startedAt() {
        return this.#startedAt;
    }
    /** Stable provider cache affinity retained when the logical session rolls over. */
    get promptCacheKey() {
        return this.#promptCacheKey;
    }
    toString() {
        return this.#value;
    }
    [Symbol.toPrimitive]() {
        return this.#value;
    }
    replace(value, startedAt = new Date().toISOString(), promptCacheKey = this.#promptCacheKey) {
        this.#value = value;
        this.#startedAt = startedAt;
        this.#promptCacheKey = promptCacheKey;
    }
}
export function resolveSessionId(source) {
    return typeof source === 'string' ? source : source.current;
}
export function resolvePromptCacheKey(source) {
    return typeof source === 'string' ? source : source.promptCacheKey;
}
//# sourceMappingURL=session-identity.js.map