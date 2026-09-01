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

export const legacyModeAdapter = Object.freeze({
  profileIdFromLegacyMode,
  legacyModeFromProfileId,
  normalizeLegacyMode,
});
