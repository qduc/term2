import { SETTING_KEYS } from '../settings/settings-schema.js';
import type { SupportedSubagentRole } from './types.js';

/**
 * Registry of model pool settings the settings UI opens a structured editor
 * for (`SubagentPoolMenuSession`), keyed by the setting that stores the
 * pool. `roleLabel` supplies the editor's copy ("Explorer Pool", "Inherit
 * explorer provider", ...).
 *
 * `role` ties the setting to a `SupportedSubagentRole` for pools the round-
 * robin `SubagentRolePoolSelector` actually resolves. Mentor is
 * deliberately omitted here even though it has a pool editor: mentor fans a
 * question out across every entry (`MentorRunner`) rather than round-
 * robining one entry per spawn, so it must never be looked up through this
 * role mapping.
 */
export const SUBAGENT_POOL_SETTINGS: ReadonlyArray<{
  key: string;
  roleLabel: string;
  role?: SupportedSubagentRole;
}> = [
  { key: SETTING_KEYS.AGENT_MENTOR_POOL, roleLabel: 'Mentor' },
  { key: SETTING_KEYS.AGENT_SUBAGENT_EXPLORER_POOL, roleLabel: 'Explorer', role: 'explorer' },
  { key: SETTING_KEYS.AGENT_SUBAGENT_WORKER_POOL, roleLabel: 'Worker', role: 'worker' },
  { key: SETTING_KEYS.AGENT_SUBAGENT_LIBRARIAN_POOL, roleLabel: 'Librarian', role: 'librarian' },
];

export const SUBAGENT_POOL_SETTING_KEYS: ReadonlySet<string> = new Set(
  SUBAGENT_POOL_SETTINGS.map((entry) => entry.key),
);

export function getSubagentPoolRoleLabel(settingKey: string): string {
  return SUBAGENT_POOL_SETTINGS.find((entry) => entry.key === settingKey)?.roleLabel ?? 'Subagent';
}

/** Maps a runtime role to its pool setting key, when one exists. */
export function getSubagentPoolSettingKeyForRole(role: SupportedSubagentRole): string | undefined {
  return SUBAGENT_POOL_SETTINGS.find((entry) => entry.role === role)?.key;
}

/**
 * Fallback provider setting per pool: the "inherit" copy and the model
 * picker's default provider come from the role's own provider setting
 * (mentor: `agent.mentorProvider`; other roles: `agent.subagent<Role>Provider`).
 */
export function getSubagentPoolFallbackProviderKey(settingKey: string): string | undefined {
  switch (settingKey) {
    case SETTING_KEYS.AGENT_MENTOR_POOL:
      return SETTING_KEYS.AGENT_MENTOR_PROVIDER;
    case SETTING_KEYS.AGENT_SUBAGENT_EXPLORER_POOL:
      return SETTING_KEYS.AGENT_SUBAGENT_EXPLORER_PROVIDER;
    case SETTING_KEYS.AGENT_SUBAGENT_WORKER_POOL:
      return SETTING_KEYS.AGENT_SUBAGENT_WORKER_PROVIDER;
    case SETTING_KEYS.AGENT_SUBAGENT_LIBRARIAN_POOL:
      return SETTING_KEYS.AGENT_SUBAGENT_LIBRARIAN_PROVIDER;
    default:
      return undefined;
  }
}
