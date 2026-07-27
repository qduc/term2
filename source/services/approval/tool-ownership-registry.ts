import { PARENT_TOOL_OWNER, type ToolOwner } from './tool-owner.js';

/**
 * How many claims to retain before evicting the oldest. Claims are only ever
 * read while their tool call is awaiting approval, so anything still resident
 * long after that is dead weight rather than state we depend on.
 */
const DEFAULT_LIMIT = 500;

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
  readonly #limit: number;

  constructor(options: { limit?: number } = {}) {
    this.#limit = options.limit ?? DEFAULT_LIMIT;
  }

  /** Record `owner` as responsible for each of `callIds`. */
  claim(callIds: Iterable<string>, owner: ToolOwner): void {
    for (const callId of callIds) {
      if (!callId) {
        continue;
      }
      // Re-inserting moves the key to the end of the Map's iteration order, so
      // eviction stays oldest-first even for a re-claimed call.
      this.#owners.delete(callId);
      this.#owners.set(callId, owner);
    }
    this.#evictOverflow();
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

  #evictOverflow(): void {
    while (this.#owners.size > this.#limit) {
      const oldest = this.#owners.keys().next();
      if (oldest.done) {
        return;
      }
      this.#owners.delete(oldest.value);
    }
  }
}

/**
 * Process-wide default, shared by the nested subagent runner (which claims) and
 * the approval flow (which reads). The two sit on opposite sides of the agent
 * client and have no common composition root to be injected from; both accept
 * an explicit registry so tests can scope one per run.
 *
 * Claims are keyed by tool call ID, which is unique per call, so entries never
 * collide across runs — a stale entry can only ever be evicted, never misread.
 */
export const toolOwnershipRegistry = new ToolOwnershipRegistry();
