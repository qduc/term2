export type GenerationToken = number;

/**
 * Owns generation and stale-attempt protection.
 *
 * Any mutation derived from asynchronous provider work must be guarded
 * through this abstraction.
 */
export class GenerationGuard {
  #generation = 0;

  get currentGeneration(): number {
    return this.#generation;
  }

  capture(): GenerationToken {
    this.#generation++;
    return this.#generation;
  }

  isCurrent(token: GenerationToken): boolean {
    return token === this.#generation;
  }

  invalidate(): void {
    this.#generation++;
  }

  runIfCurrent<T>(token: GenerationToken, mutation: () => T): boolean {
    if (!this.isCurrent(token)) return false;
    mutation();
    return true;
  }
}
