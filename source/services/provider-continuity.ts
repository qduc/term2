/**
 * Owns provider-side response chaining state: previousResponseId and
 * whether chaining has been broken (e.g. by transport downgrade).
 *
 * This is the single source of truth for provider continuity. All other
 * collaborators read from this object rather than storing their own copy.
 */
export class ProviderContinuity {
  #previousResponseId: string | null = null;
  #chainingBroken = false;

  get previousResponseId(): string | null {
    return this.#previousResponseId;
  }

  get chainingBroken(): boolean {
    return this.#chainingBroken;
  }

  update(responseId: string | null): void {
    this.#previousResponseId = responseId;
  }

  clear(): void {
    this.#previousResponseId = null;
  }

  breakChaining(): void {
    this.#previousResponseId = null;
    this.#chainingBroken = true;
  }

  isChainingAvailable(historyLength?: number): boolean {
    return !this.#chainingBroken && (this.#previousResponseId !== null || (historyLength ?? 0) <= 1);
  }
}
