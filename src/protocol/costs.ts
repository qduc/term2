/** Native accepted physical costs, not prices inferred from public usage or last response. */
import type { DirectRequestCostFact } from '../session/facts.js';
import type { WireRequestCost } from './wire.js';

/** Keep the complete native record, including optional normalized usage and price provenance. */
export function publicRequestCost(fact: DirectRequestCostFact): WireRequestCost {
  return {
    turnId: fact.turnId,
    rootTurnId: fact.rootTurnId,
    ...(fact.parentTurnId !== undefined ? { parentTurnId: fact.parentTurnId } : {}),
    record: structuredClone(fact.record),
  };
}
