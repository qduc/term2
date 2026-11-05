/** Public non-tool budget pauses: Session remains the only enforcement/answer owner. */
import type { Fact } from '../session/facts.js';
import { publicMessage } from './public.js';
import type { WireBudgetRequest, WireEvent } from './wire.js';

type BudgetFact = Extract<Fact, { readonly type: 'budget_opened' | 'budget_closed' | 'budget_observed' }>;
/** Copy actual measured evidence and accounting; never convert it into a settled price. */
export function publicBudgetRequest(fact: Extract<BudgetFact, { readonly type: 'budget_opened' }>): WireBudgetRequest {
  return { requestId: fact.requestId, turnId: fact.turnId, evidence: fact.evidence, snapshot: fact.snapshot };
}
/** Each accepted observation/open/closure has one cursor-addressable frame. */
export function budgetFactEvent(fact: BudgetFact, sessionId: string, seq: number): WireEvent {
  const base = { sessionId, seq, turnId: fact.turnId };
  if (fact.type === 'budget_opened')
    return { ...base, type: fact.type, payload: { request: publicBudgetRequest(fact) } };
  if (fact.type === 'budget_observed') return { ...base, type: fact.type, payload: { evidence: fact.evidence } };
  const decision =
    fact.decision.kind === 'steer'
      ? {
          kind: 'steer' as const,
          messages: fact.decision.items.flatMap((item) => {
            const message = publicMessage(item, fact.turnId);
            return message ? [message] : [];
          }),
        }
      : fact.decision;
  return { ...base, type: fact.type, payload: { requestId: fact.requestId, decision, source: fact.source } };
}
