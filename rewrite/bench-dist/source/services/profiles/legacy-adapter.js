export const STANDARD_PROFILE_ID = 'builtin:standard';
export const BARE_PROFILE_ID = 'builtin:bare';
/** Retired Lite Profile; saved settings, sessions, and commands that name it select Bare. */
export const LEGACY_LITE_PROFILE_ID = 'builtin:lite';
export const PLAN_PROFILE_ID = 'builtin:plan';
export const MENTOR_PROFILE_ID = 'builtin:mentor';
export const ORCHESTRATOR_PROFILE_ID = 'builtin:orchestrator';
/** Map a retired built-in Profile ID to the Profile that replaced it. */
export function canonicalProfileId(profileId) {
    return profileId === LEGACY_LITE_PROFILE_ID ? BARE_PROFILE_ID : profileId;
}
/** Compatibility projection for persisted settings; Profile identity remains canonical. */
export function profileIdFromLegacyMode(mode) {
    if (mode?.orchestratorMode)
        return ORCHESTRATOR_PROFILE_ID;
    if (mode?.liteMode)
        return BARE_PROFILE_ID;
    if (mode?.planMode)
        return PLAN_PROFILE_ID;
    if (mode?.mentorMode)
        return MENTOR_PROFILE_ID;
    return STANDARD_PROFILE_ID;
}
export function legacyModeFromProfileId(profileId) {
    switch (canonicalProfileId(profileId)) {
        case ORCHESTRATOR_PROFILE_ID:
            return { orchestratorMode: true, liteMode: false, planMode: false, mentorMode: false };
        // The legacy liteMode flag now selects Bare, so Bare projects back to it.
        case BARE_PROFILE_ID:
            return { orchestratorMode: false, liteMode: true, planMode: false, mentorMode: false };
        case PLAN_PROFILE_ID:
            return { orchestratorMode: false, liteMode: false, planMode: true, mentorMode: false };
        case MENTOR_PROFILE_ID:
            return { orchestratorMode: false, liteMode: false, planMode: false, mentorMode: true };
        case 'builtin:pair':
        case STANDARD_PROFILE_ID:
            return { orchestratorMode: false, liteMode: false, planMode: false, mentorMode: false };
        default:
            throw new Error(`Cannot project unknown Profile '${profileId}' to legacy mode flags`);
    }
}
export function normalizeLegacyMode(mode) {
    return legacyModeFromProfileId(profileIdFromLegacyMode(mode));
}
const LEGACY_MODE_SETTING_FIELDS = Object.freeze({
    'app.orchestratorMode': 'orchestratorMode',
    'app.liteMode': 'liteMode',
    'app.planMode': 'planMode',
    'app.mentorMode': 'mentorMode',
});
export function isLegacyModeSettingKey(key) {
    return Object.prototype.hasOwnProperty.call(LEGACY_MODE_SETTING_FIELDS, key);
}
/** Map one legacy setting write to the canonical Profile selected by the flags. */
export function profileIdFromLegacyModeSetting(key, value, currentProfileId) {
    if (!isLegacyModeSettingKey(key) || typeof value !== 'boolean')
        return undefined;
    const field = LEGACY_MODE_SETTING_FIELDS[key];
    if (value)
        return profileIdFromLegacyMode({ [field]: true });
    const activeField = Object.entries(LEGACY_MODE_SETTING_FIELDS).find(([, name]) => {
        try {
            return legacyModeFromProfileId(currentProfileId)[name] === true;
        }
        catch {
            return false;
        }
    })?.[1];
    return activeField === field ? STANDARD_PROFILE_ID : currentProfileId;
}
export const legacyModeAdapter = Object.freeze({
    profileIdFromLegacyMode,
    legacyModeFromProfileId,
    normalizeLegacyMode,
    profileIdFromLegacyModeSetting,
});
//# sourceMappingURL=legacy-adapter.js.map