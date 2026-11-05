import type { ModelRequestCost } from '../cost/model-cost.js';

/** A failed dispatched helper still owns its request accounting. */
export class AgentChatFailure extends Error {
  constructor(readonly costRecords: readonly ModelRequestCost[], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = cause instanceof Error ? cause.name : 'AgentChatFailure';
  }
}
