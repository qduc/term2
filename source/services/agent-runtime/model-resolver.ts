import type { ISettingsService } from '../service-interfaces.js';
import type { ModelPolicy, ExactModelPolicy } from './types.js';
import { TierModelPoolEntrySchema, type TierModelPoolSetting } from '../settings/settings-schema.js';

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

/** A model and its provider are inseparable after settings parsing. */
export type TierModelPoolEntry = TierModelPoolSetting[number];

/**
 * Validate the canonical runtime shape. Legacy conversion belongs to settings
 * parsing, never to a consumer that could rebind entries after a settings edit.
 */
export function toTierModelPoolEntries(value: unknown): TierModelPoolEntry[] {
  if (value === undefined) return [];
  return TierModelPoolEntrySchema.array().parse(value);
}

export function getTierModelPoolEntries(tier: AncillaryModelTier, settings: ISettingsService): TierModelPoolEntry[] {
  return toTierModelPoolEntries(settings.getDynamic(`agent.${tier}Model`));
}

/** A tier pool's model ids, without their pinned providers. */
export function getTierModelPool(tier: AncillaryModelTier, settings: ISettingsService): readonly string[] {
  return getTierModelPoolEntries(tier, settings).map((entry) => entry.model);
}

export function resolveAncillaryModelTier(tier: AncillaryModelTier, settings: ISettingsService): ExactModelPolicy {
  // Stable first-entry pick: resolution runs from display paths as well as
  // execution paths, so the cursor must not advance here. Round-robin over
  // the pool happens once per subagent spawn in SubagentRolePoolSelector.
  const first = getTierModelPoolEntries(tier, settings)[0];
  return (
    first ?? {
      provider: settings.get('agent.provider') ?? 'openai',
      model: settings.get('agent.model') ?? 'gpt-4o',
    }
  );
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
      (settings.getDynamic(`agent.reasoning.${policy.reasoning}`) as string | undefined) ??
      (settings.getDynamic('agent.reasoningModel') as string | undefined);
    if (reasoningModel) {
      return { provider: parentExact.provider, model: reasoningModel };
    }
  }

  const tier = policy.tier === 'lower' ? 'cheap' : 'smart';
  const first = getTierModelPoolEntries(tier as AncillaryModelTier, settings)[0];
  return first ?? parentExact;
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
