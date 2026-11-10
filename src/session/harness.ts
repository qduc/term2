/** Term2 pricing composition above the portable harness boundary. */
import {
  startTurn as coreStartTurn,
  startCompaction as coreStartCompaction,
  startNestedTurn as coreStartNestedTurn,
  type TurnDeps,
  type TurnSpec,
  type NestedRunRequest,
} from '@qduc/agent-core';
import { getModelPricing, getModelPricingVersion } from '../model/cost/pricing.js';
import { isSubscriptionProvider } from '../model/cost/subscription-providers.js';
export type { TurnSpec, TurnResult, TurnEvent, TurnHandle } from '@qduc/agent-core';
function withAccounting<AppCtx>(deps: TurnDeps<AppCtx>): TurnDeps<AppCtx> {
  return {
    ...deps,
    accounting: deps.accounting ?? {
      getPrice: getModelPricing,
      getPricingVersion: getModelPricingVersion,
      isSubscriptionProvider,
    },
  };
}
export function startTurn<AppCtx = unknown>(spec: TurnSpec, deps: TurnDeps<AppCtx>) {
  return coreStartTurn(spec, withAccounting(deps));
}
export function startCompaction<AppCtx = unknown>(spec: TurnSpec, deps: TurnDeps<AppCtx>) {
  return coreStartCompaction(spec, withAccounting(deps));
}
export function startNestedTurn<AppCtx = unknown>(
  request: NestedRunRequest,
  options: Pick<TurnSpec, 'turnId' | 'affinity'> & { readonly deps: TurnDeps<AppCtx> },
) {
  if (request.toolNames.some((name) => ['goal_check', 'propose_goal', 'session_rollover'].includes(name)))
    throw new Error('Invalid child authority: root-only tool');
  return coreStartNestedTurn(request, { ...options, deps: withAccounting(options.deps) });
}
