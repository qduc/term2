import type { ISettingsService } from '../service-interfaces.js';
import type { ModelPolicy, ExactModelPolicy } from './types.js';

export type AncillaryModelTier = 'smart' | 'balanced' | 'cheap' | 'chore';

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
  return resolveAncillaryModelTier(policyTierToAncillaryTier(tier), settings);
}

export function resolveAncillaryModelTier(tier: AncillaryModelTier, settings: ISettingsService): ExactModelPolicy {
  const model = settings.get<string>(`agent.${tier}Model`) ?? resolveLegacyTierModel(tier, settings);
  const provider = settings.get<string>(`agent.${tier}Provider`) ?? settings.get<string>('agent.provider') ?? 'openai';
  return { provider, model: model ?? settings.get<string>('agent.model') ?? 'gpt-4o' };
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

  const tier = policy.tier === 'lower' ? 'cheap' : 'smart';
  const model =
    settings.get<string>(`agent.${tier}Model`) ??
    resolveLegacyTierModel(tier, settings) ??
    settings.get<string>('agent.model') ??
    parentExact.model;
  const provider = settings.get<string>(`agent.${tier}Provider`) ?? parentExact.provider;
  return { provider, model };
}

function resolveLegacyTierModel(tier: AncillaryModelTier, settings: ISettingsService): string | undefined {
  for (const settingKey of legacyTierModelSettingKeys(tier)) {
    const model = settings.get<string>(settingKey);
    if (model !== undefined && model !== null) return model;
  }
  return undefined;
}

function policyTierToAncillaryTier(tier: string): AncillaryModelTier {
  switch (tier) {
    case 'capable':
      return 'smart';
    case 'efficient':
      return 'cheap';
    case 'balanced':
    default:
      return 'balanced';
  }
}

function legacyTierModelSettingKeys(tier: AncillaryModelTier): string[] {
  switch (tier) {
    case 'cheap':
      return ['agent.efficientModel', 'agent.subagentExplorerModel'];
    case 'smart':
      return ['agent.capableModel', 'agent.mentorModel'];
    case 'chore':
      return [];
    case 'balanced':
    default:
      return ['agent.model'];
  }
}
