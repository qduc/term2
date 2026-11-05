import { SETTING_KEYS } from './settings-schema.js';

/** Pool editor metadata; independent of role selection and runner policy. */
const SUBAGENT_POOL_SETTINGS: ReadonlyArray<{
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
