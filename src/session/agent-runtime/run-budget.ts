/** Term2 supplies its subscription billing policy to the portable accounting clock. */
import { RunBudget as CoreRunBudget, type RunBudgetPolicy } from '@qduc/agent-harness-core';
import { isSubscriptionProvider } from '../../model/cost/subscription-providers.js';
export {
  clampRunBudgetPolicy,
  type RunBudgetPolicy,
  type RunBudgetStage,
  type RunBudgetDimension,
  type RunBudgetEvidence,
  type RunBudgetEvent,
  type RunBudgetInteraction,
  type RunBudgetSnapshot,
  type ToolStallObservation,
} from '@qduc/agent-harness-core';
export class RunBudget extends CoreRunBudget {
  constructor(policy: RunBudgetPolicy, now = Date.now()) {
    super(policy, now, isSubscriptionProvider);
  }
}

interface RunBudgetSettingsReader {
  get(key: any): any;
}

/** Read the leaf-keyed settings API into the runtime policy contract. */
export function readRunBudgetPolicy(settings: RunBudgetSettingsReader): RunBudgetPolicy {
  return {
    maxUsdMicros: settings.get('agent.runBudget.maxUsdMicros'),
    maxUnpricedTokens: settings.get('agent.runBudget.maxUnpricedTokens'),
    maxActiveTimeMs: settings.get('agent.runBudget.maxActiveTimeMs'),
    warningHeadroomUsdMicros: settings.get('agent.runBudget.warningHeadroomUsdMicros'),
    warningHeadroomUnpricedTokens: settings.get('agent.runBudget.warningHeadroomUnpricedTokens'),
    warningHeadroomActiveTimeMs: settings.get('agent.runBudget.warningHeadroomActiveTimeMs'),
    softHeadroomUsdMicros: settings.get('agent.runBudget.softHeadroomUsdMicros'),
    softHeadroomUnpricedTokens: settings.get('agent.runBudget.softHeadroomUnpricedTokens'),
    softHeadroomActiveTimeMs: settings.get('agent.runBudget.softHeadroomActiveTimeMs'),
    turnBackstop: settings.get('agent.runBudget.turnBackstop'),
    extensionPercent: settings.get('agent.runBudget.extensionPercent'),
    maxParentExtensions: settings.get('agent.runBudget.maxParentExtensions'),
    identicalToolCallThreshold: settings.get('agent.runBudget.identicalToolCallThreshold'),
    escalation: settings.get('agent.runBudget.escalation') ?? 'warn',
  };
}
