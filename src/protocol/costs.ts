/**
 * Accepted physical costs, not prices inferred from public usage or last response,
 * and the presentation-only subscription comparison clients price against the
 * current catalog. Neither one changes persisted cost, budgets or spend.
 */
import type { DirectRequestCostFact } from '../session/facts.js';
import type { WireRequestCost } from './wire.js';

export { subscriptionReferenceCost } from '../model/cost/reference-cost.js';

/** Keep the complete native record, including optional normalized usage and price provenance. */
export function publicRequestCost(fact: DirectRequestCostFact): WireRequestCost {
  return {
    turnId: fact.turnId,
    rootTurnId: fact.rootTurnId,
    ...(fact.parentTurnId !== undefined ? { parentTurnId: fact.parentTurnId } : {}),
    record: structuredClone(fact.record),
  };
}
