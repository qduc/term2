import type { ISettingsService } from '../service-interfaces.js';
import type { ModelPolicy, ExactModelPolicy } from './types.js';

/**
 * Resolve a model policy to a concrete {provider, model} pair.
 *
 * - `ExactModelPolicy` → passes through unchanged.
 * - `ModelTier` (efficient|balanced|capable) → reads from settings.
 * - `RelativeModelPolicy` → adjusts relative to `parent`; requires a parent.
 */
export function resolveModelPolicy(
  policy: ModelPolicy,
  settings: ISettingsService,
  parent?: ModelPolicy,
): ExactModelPolicy {
  // 1. Exact policy: pass-through.
  if (typeof policy === 'object' && 'provider' in policy && 'model' in policy) {
    return { provider: policy.provider, model: policy.model };
  }

  // 2. Relative policy: requires parent.
  if (typeof policy === 'object' && 'tier' in policy) {
    if (!parent) {
      throw new Error('Relative model policy requires a parent agent policy.');
    }
    return resolveRelativePolicy(policy, settings, parent);
  }

  // 3. Named tier.
  return resolveTierPolicy(policy, settings);
}

function resolveTierPolicy(tier: string, settings: ISettingsService): ExactModelPolicy {
  const provider = settings.get<string>('agent.provider') ?? 'openai';
  const model = resolveConfiguredTierModel(tier, settings) ?? settings.get<string>('agent.model') ?? 'gpt-4o';
  return { provider, model };
}

function resolveRelativePolicy(
  policy: { tier: 'lower' | 'same' | 'higher'; reasoning?: 'low' | 'medium' | 'high' },
  settings: ISettingsService,
  parent: ModelPolicy,
): ExactModelPolicy {
  // Resolve parent to exact first.
  const parentExact = resolveModelPolicy(parent, settings);

  if (policy.tier === 'same') {
    return parentExact;
  }

  if (policy.reasoning) {
    // MVP: all reasoning effort levels resolve to the same configured
    // reasoning model. Granular per-effort settings can be added later.
    const reasoningModel =
      settings.get<string>(`agent.reasoning.${policy.reasoning}`) ?? settings.get<string>('agent.reasoningModel');
    if (reasoningModel) {
      return { provider: parentExact.provider, model: reasoningModel };
    }
  }

  const tier = policy.tier === 'lower' ? 'efficient' : 'capable';
  const tierModel = resolveConfiguredTierModel(tier, settings);
  const model = tierModel ?? settings.get<string>('agent.model') ?? parentExact.model;
  return { provider: parentExact.provider, model };
}

function resolveConfiguredTierModel(tier: string, settings: ISettingsService): string | undefined {
  for (const settingKey of tierModelSettingKeys(tier)) {
    const model = settings.get<string>(settingKey);
    if (model !== undefined && model !== null) return model;
  }
  return undefined;
}

function tierModelSettingKeys(tier: string): string[] {
  switch (tier) {
    case 'efficient':
      return ['agent.efficientModel', 'agent.subagentExplorerModel'];
    case 'capable':
      return ['agent.capableModel', 'agent.mentorModel'];
    case 'balanced':
    default:
      return ['agent.model'];
  }
}
