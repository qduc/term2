import { builtinProfileRegistry } from './registry.js';

/**
 * Return the lowercase registry name for a built-in Profile ID.
 * Display consumers apply casing, not their own ID-to-name maps.
 * Unknown IDs intentionally fall back to Standard for safe, stable display
 * while custom Profile presentation metadata is not yet available.
 */
export function getProfileLabel(profileId: string): string {
  return (builtinProfileRegistry.profiles.get(profileId)?.name ?? 'Standard').toLowerCase();
}
