import { SETTING_KEYS } from '../settings/settings-schema.js';
import type { AncillaryModelTier } from '../agent-runtime/model-resolver.js';
import type { SupportedSubagentRole } from './types.js';

/**
 * Each subagent role draws its model from one ancillary tier; the tier's
 * model setting (`agent.<tier>Model`) is the role's round-robin model pool.
 * Mentor fans a question out across its own `agent.mentorPool` entries
 * (`MentorRunner`) instead of drawing from a tier.
 */
export const ROLE_ANCILLARY_TIERS: Record<Exclude<SupportedSubagentRole, 'mentor'>, AncillaryModelTier> = {
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
 * Model pool settings the settings UI opens a structured editor for
 * (`SubagentPoolMenuSession`), keyed by the setting that stores the pool.
 * `roleLabel` supplies the editor's copy ("Mentor Pool", "Smart Pool", ...).
 *
 * `entryShape` selects the editor's entry model: tier model pools hold plain
 * model-id strings (`'models'`), while the mentor pool holds
 * `{model, provider, reasoningEffort}` entries (`'entries'`).
 */
export const SUBAGENT_POOL_SETTINGS: ReadonlyArray<{
  key: string;
  roleLabel: string;
  entryShape: 'entries' | 'models';
}> = [
  { key: SETTING_KEYS.AGENT_MENTOR_POOL, roleLabel: 'Mentor', entryShape: 'entries' },
  { key: SETTING_KEYS.AGENT_SMART_MODEL, roleLabel: 'Smart', entryShape: 'models' },
  { key: SETTING_KEYS.AGENT_BALANCED_MODEL, roleLabel: 'Balanced', entryShape: 'models' },
  { key: SETTING_KEYS.AGENT_CHEAP_MODEL, roleLabel: 'Cheap', entryShape: 'models' },
  { key: SETTING_KEYS.AGENT_CHORE_MODEL, roleLabel: 'Chore', entryShape: 'models' },
];

export const SUBAGENT_POOL_SETTING_KEYS: ReadonlySet<string> = new Set(
  SUBAGENT_POOL_SETTINGS.map((entry) => entry.key),
);

export function getSubagentPoolRoleLabel(settingKey: string): string {
  return SUBAGENT_POOL_SETTINGS.find((entry) => entry.key === settingKey)?.roleLabel ?? 'Subagent';
}

export function getSubagentPoolEntryShape(settingKey: string): 'entries' | 'models' {
  return SUBAGENT_POOL_SETTINGS.find((entry) => entry.key === settingKey)?.entryShape ?? 'entries';
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

/**
 * Fallback provider setting per pool: the "inherit" copy and the model
 * picker's default provider come from the pool's own provider setting
 * (mentor: `agent.mentorProvider`; tiers: `agent.<tier>Provider`).
 */
export function getSubagentPoolFallbackProviderKey(settingKey: string): string | undefined {
  switch (settingKey) {
    case SETTING_KEYS.AGENT_MENTOR_POOL:
      return SETTING_KEYS.AGENT_MENTOR_PROVIDER;
    case SETTING_KEYS.AGENT_SMART_MODEL:
      return SETTING_KEYS.AGENT_SMART_PROVIDER;
    case SETTING_KEYS.AGENT_BALANCED_MODEL:
      return SETTING_KEYS.AGENT_BALANCED_PROVIDER;
    case SETTING_KEYS.AGENT_CHEAP_MODEL:
      return SETTING_KEYS.AGENT_CHEAP_PROVIDER;
    case SETTING_KEYS.AGENT_CHORE_MODEL:
      return SETTING_KEYS.AGENT_CHORE_PROVIDER;
    default:
      return undefined;
  }
}
