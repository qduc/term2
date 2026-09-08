/**
 * Mutable identity shared by the retained session graph.  A rollover changes
 * the persistence/telemetry identity, but does not replace the graph that owns
 * tools, permissions, or live background work.
 */
export class SessionIdentity {
  #value: string;
  #startedAt: string;
  #promptCacheKey: string;

  constructor(value: string, startedAt = new Date().toISOString(), promptCacheKey = value) {
    this.#value = value;
    this.#startedAt = startedAt;
    this.#promptCacheKey = promptCacheKey;
  }

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
