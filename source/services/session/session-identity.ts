/**
 * Mutable identity shared by the retained session graph.  A rollover changes
 * the persistence/telemetry identity, but does not replace the graph that owns
 * tools, permissions, or live background work.
 */
export class SessionIdentity {
  #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  get current(): string {
    return this.#value;
  }

  toString(): string {
    return this.#value;
  }

  [Symbol.toPrimitive](): string {
    return this.#value;
  }

  replace(value: string): void {
    this.#value = value;
  }
}

export type SessionIdSource = string | SessionIdentity;

export function resolveSessionId(source: SessionIdSource): string {
  return typeof source === 'string' ? source : source.current;
}
