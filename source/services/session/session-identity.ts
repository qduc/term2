/**
 * Identity shared by the retained session graph. An internal context rollover
 * moves the current conversation/persistence identity while the public process
 * session identity remains fixed; an explicit new-session action constructs a
 * new instance.
 */
export class SessionIdentity {
  #value: string;
  #startedAt: string;
  readonly #publicId: string;
  readonly #publicStartedAt: string;
  #promptCacheKey: string;

  constructor(value: string, startedAt = new Date().toISOString(), promptCacheKey = value) {
    this.#value = value;
    this.#startedAt = startedAt;
    this.#publicId = value;
    this.#publicStartedAt = startedAt;
    this.#promptCacheKey = promptCacheKey;
  }

  /** Stable external session identity for the lifetime of this retained graph. */
  get publicId(): string {
    return this.#publicId;
  }

  get publicStartedAt(): string {
    return this.#publicStartedAt;
  }

  /** Current persisted conversation identity; changes on internal context rollover. */
  get current(): string {
    return this.#value;
  }

  get startedAt(): string {
    return this.#startedAt;
  }

  /** Stable provider cache affinity retained when the logical session rolls over. */
  get promptCacheKey(): string {
    return this.#promptCacheKey;
  }

  toString(): string {
    return this.#value;
  }

  [Symbol.toPrimitive](): string {
    return this.#value;
  }

  replace(value: string, startedAt = new Date().toISOString(), promptCacheKey = this.#promptCacheKey): void {
    this.#value = value;
    this.#startedAt = startedAt;
    this.#promptCacheKey = promptCacheKey;
  }
}

export type SessionIdSource = string | SessionIdentity;

export function resolveSessionId(source: SessionIdSource): string {
  return typeof source === 'string' ? source : source.current;
}

export function resolvePromptCacheKey(source: SessionIdSource): string {
  return typeof source === 'string' ? source : source.promptCacheKey;
}
