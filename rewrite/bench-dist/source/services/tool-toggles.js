import { SETTING_KEYS } from './settings/settings-schema.js';
const CAPABILITY_GROUPS = [
    { key: SETTING_KEYS.TOOLS_SHELL_ENABLED, capabilities: ['shell'] },
    { key: SETTING_KEYS.TOOLS_WEB_ENABLED, capabilities: ['web'] },
    // filesystem-read-external has no separate toggle: fileRead masks both read
    // capabilities.
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
const CAPABILITY_GROUP_KEYS = new Set(CAPABILITY_GROUPS.map((group) => group.key));
export function isToolToggleKey(key) {
    return CAPABILITY_GROUP_KEYS.has(key);
}
/**
 * The capability group strings currently masked by disabled toggles. Returns a
 * fresh set each call; callers may mutate it to derive an effective set.
 */
export function resolveDisabledCapabilities(settings) {
    const masked = new Set();
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
const PROFILE_TOGGLE_CONFLICTS = {
    'builtin:orchestrator': {
        label: 'Orchestrator',
        toggles: [
            SETTING_KEYS.TOOLS_FILE_WRITE_ENABLED,
            SETTING_KEYS.TOOLS_SHELL_ENABLED,
            SETTING_KEYS.TOOLS_SUBAGENTS_ENABLED,
        ],
    },
    'builtin:mentor': {
        label: 'Mentor',
        toggles: [
            SETTING_KEYS.TOOLS_FILE_WRITE_ENABLED,
            SETTING_KEYS.TOOLS_SHELL_ENABLED,
            SETTING_KEYS.TOOLS_MENTOR_ENABLED,
        ],
    },
    'builtin:standard': {
        label: 'Standard',
        toggles: [
            SETTING_KEYS.TOOLS_FILE_WRITE_ENABLED,
            SETTING_KEYS.TOOLS_SHELL_ENABLED,
            SETTING_KEYS.TOOLS_SUBAGENTS_ENABLED,
        ],
    },
    'builtin:plan': {
        label: 'Plan',
        toggles: [
            SETTING_KEYS.TOOLS_FILE_WRITE_ENABLED,
            SETTING_KEYS.TOOLS_SHELL_ENABLED,
            SETTING_KEYS.TOOLS_SUBAGENTS_ENABLED,
        ],
    },
    'builtin:bare': {
        label: 'Bare',
        toggles: [SETTING_KEYS.TOOLS_SHELL_ENABLED],
    },
};
/**
 * One warning notice per apply batch listing the newly disabled toggles that
 * conflict with the now-active profile. Returns null when nothing conflicts.
 * `newlyDisabledKeys` must contain only toggles whose value changed true→false.
 */
export function buildToggleConflictNotice(settings, newlyDisabledKeys) {
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
        return `Tool warning: ${conflicting.join(', ')} disabled while the ${conflicts.label} profile's guidance still references these tools; the model may attempt unavailable tools.`;
    }
    if (activeProfileId.startsWith('builtin:')) {
        return null;
    }
    return `Tool warning: ${newlyDisabledKeys.join(', ')} disabled for non-builtin profile '${activeProfileId}', whose guidance may reference these tools.`;
}
//# sourceMappingURL=tool-toggles.js.map