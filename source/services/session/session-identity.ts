/**
 * Mutable identity shared by the retained session graph.  A rollover changes
 * the persistence/telemetry identity, but does not replace the graph that owns
 * tools, permissions, or live background work.
 */
export class SessionIdentity {
  #value: string;
  #startedAt: string;

  constructor(value: string, startedAt = new Date().toISOString()) {
    this.#value = value;
    this.#startedAt = startedAt;
  }

  get current(): string {
    return this.#value;
  }

  get startedAt(): string {
    return this.#startedAt;
  }

  toString(): string {
    return this.#value;
  }

  [Symbol.toPrimitive](): string {
    return this.#value;
  }

  replace(value: string, startedAt = new Date().toISOString()): void {
    this.#value = value;
    this.#startedAt = startedAt;
  }
}

export type SessionIdSource = string | SessionIdentity;

export function resolveSessionId(source: SessionIdSource): string {
  return typeof source === 'string' ? source : source.current;
}
