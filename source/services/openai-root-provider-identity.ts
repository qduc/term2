import type { ProviderCheckpointIdentity } from './provider-continuity.js';

/**
 * Root-owned, resolved OpenAI provider identity shared by lifecycle observation
 * and selector-parity assessment. It contains no credentials or request data.
 */
export class OpenAIRootProviderIdentity {
  #identity: Readonly<ProviderCheckpointIdentity> | null = null;

  get current(): Readonly<ProviderCheckpointIdentity> | null {
    return this.#identity;
  }

  observe(identity: ProviderCheckpointIdentity): void {
    if (!identity.provider || !identity.endpoint || !identity.model) return;
    this.#identity = Object.freeze({ ...identity });
  }
}
