import { SETTING_KEYS } from './settings/settings-schema.js';

/**
 * Per-tool-group kill switches for the main agent (docs/plans/tool-toggle-setting-design.md).
 *
 * Phase 1 contract: each toggle masks one capability group from the resolved
 * profile's tool capabilities. Masking happens after profile resolution, so
 * profiles stay declarative and a disabled group's tools disappear together
 * with its capability-gated prompt fragments. Toggles never restrict
 * subagents, which resolve their own capabilities.
 */

type CapabilityGroup = {
  key: string;
  capabilities: readonly string[];
};

const CAPABILITY_GROUPS: readonly CapabilityGroup[] = [
  { key: SETTING_KEYS.TOOLS_SHELL_ENABLED, capabilities: ['shell'] },
  { key: SETTING_KEYS.TOOLS_WEB_ENABLED, capabilities: ['web'] },
  // filesystem-read-external has no separate toggle: fileRead masks both read
  // capabilities. Lite keeps its outside-workspace read authority, which is
  // keyed on liteMode, not on a capability.
  {
    key: SETTING_KEYS.TOOLS_FILE_READ_ENABLED,
    capabilities: ['filesystem-read-workspace', 'filesystem-read-external'],
  },
  { key: SETTING_KEYS.TOOLS_FILE_WRITE_ENABLED, capabilities: ['filesystem-write'] },
  { key: SETTING_KEYS.TOOLS_MEMORY_ENABLED, capabilities: ['memory'] },
  { key: SETTING_KEYS.TOOLS_SESSIONS_ENABLED, capabilities: ['sessions'] },
  { key: SETTING_KEYS.TOOLS_SKILLS_ENABLED, capabilities: ['skills'] },
  { key: SETTING_KEYS.TOOLS_MENTOR_ENABLED, capabilities: ['mentor'] },
  { key: SETTING_KEYS.TOOLS_SUBAGENTS_ENABLED, capabilities: ['subagents'] },
  { key: SETTING_KEYS.TOOLS_BACKGROUND_TASKS_ENABLED, capabilities: ['background-tasks'] },
  { key: SETTING_KEYS.TOOLS_USER_INTERACTION_ENABLED, capabilities: ['user-interaction'] },
  { key: SETTING_KEYS.TOOLS_CODE_CONTEXT_ENABLED, capabilities: ['code-context'] },
];

const CAPABILITY_GROUP_KEYS: ReadonlySet<string> = new Set(CAPABILITY_GROUPS.map((group) => group.key));

export function isToolToggleKey(key: string): boolean {
  return CAPABILITY_GROUP_KEYS.has(key);
}

export function getToolToggleKeys(): readonly string[] {
  return [...CAPABILITY_GROUP_KEYS];
}

/** Minimal read surface of ISettingsService, for testability without the full service. */
type SettingsReader = {
  getDynamic(key: string): unknown;
  get(key: string): unknown;
};

/**
 * The capability group strings currently masked by disabled toggles. Returns a
 * fresh set each call; callers may mutate it to derive an effective set.
 */
export function resolveDisabledCapabilities(settings: SettingsReader): Set<string> {
  const masked = new Set<string>();
  for (const group of CAPABILITY_GROUPS) {
    if (settings.getDynamic(group.key) === false) {
      for (const capability of group.capabilities) {
        masked.add(capability);
      }
    }
  }
  return masked;
}

/**
 * Profile guidance that references a toggle's tools even when the toggle is
 * off: those models may attempt unavailable tools mid-run. Only conflicts the
 * design doc identified are listed; anything else is considered intentional.
 */
const PROFILE_TOGGLE_CONFLICTS: Record<string, { label: string; toggles: readonly string[] }> = {
  'builtin:orchestrator': { label: 'Orchestrator', toggles: [SETTING_KEYS.TOOLS_SUBAGENTS_ENABLED] },
  'builtin:mentor': { label: 'Mentor', toggles: [SETTING_KEYS.TOOLS_MENTOR_ENABLED] },
  'builtin:standard': {
    label: 'Standard',
    toggles: [SETTING_KEYS.TOOLS_FILE_WRITE_ENABLED, SETTING_KEYS.TOOLS_SUBAGENTS_ENABLED],
  },
  'builtin:plan': {
    label: 'Plan',
    toggles: [SETTING_KEYS.TOOLS_FILE_WRITE_ENABLED, SETTING_KEYS.TOOLS_SUBAGENTS_ENABLED],
  },
  'builtin:lite': {
    label: 'Lite',
    toggles: [
      SETTING_KEYS.TOOLS_SHELL_ENABLED,
      SETTING_KEYS.TOOLS_WEB_ENABLED,
      SETTING_KEYS.TOOLS_FILE_READ_ENABLED,
      SETTING_KEYS.TOOLS_FILE_WRITE_ENABLED,
    ],
  },
};

/**
 * One warning notice per apply batch listing the newly disabled toggles that
 * conflict with the now-active profile. Returns null when nothing conflicts.
 * `newlyDisabledKeys` must contain only toggles whose value changed true→false.
 */
export function buildToggleConflictNotice(
  settings: SettingsReader,
  newlyDisabledKeys: readonly string[],
): string | null {
  if (newlyDisabledKeys.length === 0) {
    return null;
  }

  const activeProfileId = String(settings.get('app.activeProfileId') ?? '');
  const conflicts = PROFILE_TOGGLE_CONFLICTS[activeProfileId];

  if (conflicts) {
    const conflicting = newlyDisabledKeys.filter((key) => conflicts.toggles.includes(key));
    if (conflicting.length === 0) {
      return null;
    }
    return `Tool warning: ${conflicting.join(', ')} disabled while the ${
      conflicts.label
    } profile's guidance still references these tools; the model may attempt unavailable tools.`;
  }

  if (activeProfileId.startsWith('builtin:')) {
    return null;
  }

  return `Tool warning: ${newlyDisabledKeys.join(
    ', ',
  )} disabled for non-builtin profile '${activeProfileId}', whose guidance may reference these tools.`;
}
