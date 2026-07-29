export type ProviderCheckpointIdentity = {
  provider: string;
  account: string;
  endpoint: string;
  model: string;
};

export type ProviderCheckpointPrefix = {
  revision: number;
  identity: string;
};

export type ProviderCheckpointBinding = {
  identity: ProviderCheckpointIdentity;
  prefix: ProviderCheckpointPrefix;
};

export type ProviderCheckpointRetirement = {
  code: 'reset' | 'superseded' | 'chaining_broken' | 'identity_mismatch' | 'prefix_mismatch';
};

export type ProviderCheckpoint = ProviderCheckpointBinding & {
  state: 'candidate' | 'accepted' | 'retired';
  lineage: number;
  responseId: string;
  opaqueState?: unknown;
  retirement?: ProviderCheckpointRetirement;
};

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
  #lineage = 0;
  #checkpoint: ProviderCheckpoint | null = null;
  #retiredCheckpoints: ProviderCheckpoint[] = [];

  get previousResponseId(): string | null {
    return this.#previousResponseId;
  }

  get chainingBroken(): boolean {
    return this.#chainingBroken;
  }

  get checkpoint(): ProviderCheckpoint | null {
    return this.#checkpoint;
  }

  get retiredCheckpoints(): readonly ProviderCheckpoint[] {
    return this.#retiredCheckpoints;
  }

  /**
   * Records a provider response observed before its terminal history is
   * committed. This deliberately does not update previousResponseId: existing
   * wire continuity remains owned by update().
   */
  observeCandidate(
    candidate: ProviderCheckpointBinding & { responseId: string; opaqueState?: unknown; lineage?: number },
  ): boolean {
    if (candidate.lineage !== undefined && candidate.lineage !== this.#lineage) {
      return false;
    }
    this.#retireCheckpoint('superseded');
    this.#checkpoint = {
      ...candidate,
      lineage: this.#lineage,
      state: 'candidate',
    };
    return true;
  }

  /**
   * Accepts only the candidate for this exact terminal response and binding.
   * Call this in the same current-generation callback that committed history.
   */
  promoteCandidate(responseId: string | null, binding?: ProviderCheckpointBinding): boolean {
    const checkpoint = this.#checkpoint;
    if (
      !checkpoint ||
      checkpoint.state !== 'candidate' ||
      checkpoint.lineage !== this.#lineage ||
      checkpoint.responseId !== responseId
    ) {
      return false;
    }
    if (binding) {
      const retirement = ProviderContinuity.#bindingMismatch(checkpoint, binding);
      if (retirement) {
        this.#retireCheckpoint(retirement);
        return false;
      }
    }
    this.#checkpoint = { ...checkpoint, state: 'accepted' };
    return true;
  }

  update(responseId: string | null): void {
    this.#previousResponseId = responseId;
  }

  clear(): void {
    this.#previousResponseId = null;
    this.#retireCheckpoint('reset');
    this.#lineage++;
  }

  breakChaining(): void {
    this.#previousResponseId = null;
    this.#chainingBroken = true;
    this.#retireCheckpoint('chaining_broken');
  }

  isChainingAvailable(historyLength?: number): boolean {
    return !this.#chainingBroken && (this.#previousResponseId !== null || (historyLength ?? 0) <= 1);
  }

  #retireCheckpoint(code: ProviderCheckpointRetirement['code']): void {
    if (!this.#checkpoint) return;
    this.#retiredCheckpoints.push({ ...this.#checkpoint, state: 'retired', retirement: { code } });
    this.#checkpoint = null;
  }

  static #bindingMismatch(
    left: ProviderCheckpointBinding,
    right: ProviderCheckpointBinding,
  ): ProviderCheckpointRetirement['code'] | null {
    if (
      left.identity.provider !== right.identity.provider ||
      left.identity.account !== right.identity.account ||
      left.identity.endpoint !== right.identity.endpoint ||
      left.identity.model !== right.identity.model
    ) {
      return 'identity_mismatch';
    }
    if (left.prefix.revision !== right.prefix.revision || left.prefix.identity !== right.prefix.identity) {
      return 'prefix_mismatch';
    }
    return null;
  }
}
