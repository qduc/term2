import { SETTING_KEYS } from '../../config/settings/settings-schema.js';
import type { AncillaryModelTier } from '../../session/agent-runtime/model-resolver.js';
import type { SupportedSubagentRole } from './types.js';

/**
 * Each subagent role draws its model from one ancillary tier; the tier's
 * model setting (`agent.<tier>Model`) is the role's round-robin model pool.
 * Mentor fans a question out across its own `agent.mentorPool` entries
 * (`delegation/direct/subagent-callbacks.ts`) instead of drawing from a tier.
 */
const ROLE_ANCILLARY_TIERS: Record<Exclude<SupportedSubagentRole, 'mentor'>, AncillaryModelTier> = {
  explorer: 'cheap',
  worker: 'balanced',
  librarian: 'cheap',
  reviewer: 'smart',
};

export function getAncillaryTierForRole(role: SupportedSubagentRole | string): AncillaryModelTier {
  if (role === 'mentor') return 'smart';
  return (ROLE_ANCILLARY_TIERS as Record<string, AncillaryModelTier | undefined>)[role] ?? 'balanced';
}

/**
 * Maps a runtime role to its pool setting key (its tier's model setting).
 * Mentor is excluded: it draws from `agent.mentorPool`, never a tier pool.
 */
export function getSubagentPoolSettingKeyForRole(role: SupportedSubagentRole): string | undefined {
  if (role === 'mentor') return undefined;
  const tier = getAncillaryTierForRole(role);
  if (!tier) return undefined;
  switch (tier) {
    case 'smart':
      return SETTING_KEYS.AGENT_SMART_MODEL;
    case 'balanced':
      return SETTING_KEYS.AGENT_BALANCED_MODEL;
    case 'cheap':
      return SETTING_KEYS.AGENT_CHEAP_MODEL;
    case 'chore':
      return SETTING_KEYS.AGENT_CHORE_MODEL;
  }
}
