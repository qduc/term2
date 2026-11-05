import { PARENT_TOOL_OWNER, type ToolOwner } from './tool-owner.js';

/**
 * Answers "which agent owns this pending tool call?".
 *
 * A nested subagent run claims the call IDs of the approvals it is blocked on
 * at the moment it surfaces them. The parent's approval flow then attributes an
 * interruption by lookup instead of reconstructing ownership from the agent
 * SDK's private run state.
 *
 * Unknown call IDs belong to the parent by definition: a tool call that no
 * subagent claimed was issued by the top-level agent.
 */
export class ToolOwnershipRegistry {
  readonly #owners = new Map<string, ToolOwner>();

  /**
   * Retained only for source compatibility with callers that once configured
   * count eviction. Live claims are now released by their lifecycle owners.
   */
  constructor(_options: { limit?: number } = {}) {}

  /** Record `owner` as responsible for each of `callIds`. */
  claim(callIds: Iterable<string>, owner: ToolOwner): void {
    for (const callId of callIds) {
      if (!callId) {
        continue;
      }
      this.#owners.delete(callId);
      this.#owners.set(callId, owner);
    }
  }

  ownerOf(callId: string | undefined): ToolOwner {
    if (!callId) {
      return PARENT_TOOL_OWNER;
    }
    return this.#owners.get(callId) ?? PARENT_TOOL_OWNER;
  }

  release(callId: string): void {
    this.#owners.delete(callId);
  }

  clear(): void {
    this.#owners.clear();
  }

  get size(): number {
    return this.#owners.size;
  }
}
