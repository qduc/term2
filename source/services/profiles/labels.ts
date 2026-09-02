import {
  MENTOR_PROFILE_ID,
  LITE_PROFILE_ID,
  ORCHESTRATOR_PROFILE_ID,
  PLAN_PROFILE_ID,
  STANDARD_PROFILE_ID,
} from './legacy-adapter.js';

/**
 * Return the lowercase display label for a built-in Profile ID.
 * Unknown IDs intentionally fall back to Standard for safe, stable display
 * while custom Profile presentation metadata is not yet available.
 */
export function getProfileLabel(profileId: string): string {
  switch (profileId) {
    case LITE_PROFILE_ID:
      return 'lite';
    case PLAN_PROFILE_ID:
      return 'plan';
    case MENTOR_PROFILE_ID:
      return 'mentor';
    case ORCHESTRATOR_PROFILE_ID:
      return 'orchestrator';
    case STANDARD_PROFILE_ID:
    default:
      return 'standard';
  }
}
