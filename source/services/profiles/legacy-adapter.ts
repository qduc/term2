import type { ProfileId, SavedAppMode } from './types.js';

export const STANDARD_PROFILE_ID = 'builtin:standard' as const;
export const LITE_PROFILE_ID = 'builtin:lite' as const;
export const PLAN_PROFILE_ID = 'builtin:plan' as const;
export const MENTOR_PROFILE_ID = 'builtin:mentor' as const;
export const ORCHESTRATOR_PROFILE_ID = 'builtin:orchestrator' as const;

/** Compatibility projection for persisted settings; Profile identity remains canonical. */
export function profileIdFromLegacyMode(mode: Partial<SavedAppMode> | undefined): ProfileId {
  if (mode?.orchestratorMode) return ORCHESTRATOR_PROFILE_ID;
  if (mode?.liteMode) return LITE_PROFILE_ID;
  if (mode?.planMode) return PLAN_PROFILE_ID;
  if (mode?.mentorMode) return MENTOR_PROFILE_ID;
  return STANDARD_PROFILE_ID;
}

export function legacyModeFromProfileId(profileId: string): SavedAppMode {
  switch (profileId) {
    case ORCHESTRATOR_PROFILE_ID:
      return { orchestratorMode: true, liteMode: false, planMode: false, mentorMode: false };
    case LITE_PROFILE_ID:
      return { orchestratorMode: false, liteMode: true, planMode: false, mentorMode: false };
    case PLAN_PROFILE_ID:
      return { orchestratorMode: false, liteMode: false, planMode: true, mentorMode: false };
    case MENTOR_PROFILE_ID:
      return { orchestratorMode: false, liteMode: false, planMode: false, mentorMode: true };
    case STANDARD_PROFILE_ID:
      return { orchestratorMode: false, liteMode: false, planMode: false, mentorMode: false };
    default:
      throw new Error(`Cannot project unknown Profile '${profileId}' to legacy mode flags`);
  }
}

export function normalizeLegacyMode(mode: Partial<SavedAppMode> | undefined): SavedAppMode {
  return legacyModeFromProfileId(profileIdFromLegacyMode(mode));
}

const LEGACY_MODE_SETTING_FIELDS = Object.freeze({
  'app.orchestratorMode': 'orchestratorMode',
  'app.liteMode': 'liteMode',
  'app.planMode': 'planMode',
  'app.mentorMode': 'mentorMode',
} as const);

export type LegacyModeSettingKey = keyof typeof LEGACY_MODE_SETTING_FIELDS;

export function isLegacyModeSettingKey(key: string): key is LegacyModeSettingKey {
  return Object.prototype.hasOwnProperty.call(LEGACY_MODE_SETTING_FIELDS, key);
}

/** Map one legacy setting write to the canonical Profile selected by the flags. */
export function profileIdFromLegacyModeSetting(
  key: string,
  value: unknown,
  currentProfileId: string,
): ProfileId | undefined {
  if (!isLegacyModeSettingKey(key) || typeof value !== 'boolean') return undefined;
  const field = LEGACY_MODE_SETTING_FIELDS[key];
  if (value) return profileIdFromLegacyMode({ [field]: true });
  const activeField = Object.entries(LEGACY_MODE_SETTING_FIELDS).find(([, name]) => {
    try {
      return legacyModeFromProfileId(currentProfileId)[name] === true;
    } catch {
      return false;
    }
  })?.[1];
  return activeField === field ? STANDARD_PROFILE_ID : (currentProfileId as ProfileId);
}

export const legacyModeAdapter = Object.freeze({
  profileIdFromLegacyMode,
  legacyModeFromProfileId,
  normalizeLegacyMode,
  profileIdFromLegacyModeSetting,
});
