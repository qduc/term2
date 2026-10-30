import { TierModelPoolEntrySchema } from '../settings/settings-schema.js';
import { ModelSelectionSchema } from '../settings/model-selection.js';
/**
 * Resolve a model policy to a concrete {provider, model} pair.
 *
 * - `ExactModelPolicy` → passes through unchanged.
 * - `ModelTier` (efficient|balanced|capable) → reads from settings.
 * - `RelativeModelPolicy` → adjusts relative to `parent`; requires a parent.
 */
export function resolveModelPolicy(policy, settings, parent) {
    // 1. Exact policy: pass-through.
    if (typeof policy === 'object' && 'provider' in policy && 'model' in policy) {
        return ModelSelectionSchema.parse(policy);
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
function resolveTierPolicy(tier, settings) {
    return resolveAncillaryModelTier(policyTierToAncillaryTier(tier), settings);
}
/**
 * Validate the canonical runtime shape without rebinding entries after a settings edit.
 */
export function toTierModelPoolEntries(value) {
    if (value === undefined)
        return [];
    return TierModelPoolEntrySchema.array().parse(value);
}
export function getTierModelPoolEntries(tier, settings) {
    return toTierModelPoolEntries(settings.getDynamic(`agent.${tier}Model`));
}
/** A tier pool's model ids, without their pinned providers. */
export function getTierModelPool(tier, settings) {
    return getTierModelPoolEntries(tier, settings).map((entry) => entry.model);
}
export function resolveAncillaryModelTier(tier, settings) {
    // Stable first-entry pick: resolution runs from display paths as well as
    // execution paths, so the cursor must not advance here. Round-robin over
    // the pool happens once per subagent spawn in SubagentRolePoolSelector.
    const first = getTierModelPoolEntries(tier, settings)[0];
    return first ?? ModelSelectionSchema.parse(settings.get('agent.modelSelection'));
}
function resolveRelativePolicy(policy, settings, parent) {
    // Resolve parent to exact first.
    const parentExact = resolveModelPolicy(parent, settings);
    if (policy.tier === 'same') {
        return parentExact;
    }
    const tier = policy.tier === 'lower' ? 'cheap' : 'smart';
    const first = getTierModelPoolEntries(tier, settings)[0];
    return first ?? parentExact;
}
function policyTierToAncillaryTier(tier) {
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
//# sourceMappingURL=model-resolver.js.map