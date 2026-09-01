import type { ISettingsService } from '../service-interfaces.js';
import { resolveProfile } from './resolver.js';
import { ProfileResolutionError } from './types.js';
import type { ResolveOptions, ResolvedEnforcementPolicy, ResolvedProfile } from './types.js';

const STANDARD_PROFILE_ID = 'builtin:standard';
const enforcementCache = new WeakMap<ISettingsService, { profileId: string; enforcement: ResolvedEnforcementPolicy }>();

const readActiveProfileId = (settingsService: ISettingsService): string => {
  const value = settingsService.get('app.activeProfileId');
  return typeof value === 'string' && value.trim().length > 0 ? value : STANDARD_PROFILE_ID;
};

export function resolveActiveProfile(settingsService: ISettingsService, options?: ResolveOptions): ResolvedProfile {
  return resolveProfile(readActiveProfileId(settingsService), options);
}

export function resolveActiveEnforcement(settingsService: ISettingsService): ResolvedEnforcementPolicy {
  const profileId = readActiveProfileId(settingsService);
  const cached = enforcementCache.get(settingsService);
  if (cached?.profileId === profileId) return cached.enforcement;

  let enforcement: ResolvedEnforcementPolicy;
  try {
    enforcement = resolveActiveProfile(settingsService).enforcement;
  } catch (error) {
    if (!(error instanceof ProfileResolutionError)) throw error;
    enforcement = {
      policies: new Set(),
      denials: new Set(),
      handoffRestrictions: new Set(),
    };
  }
  enforcementCache.set(settingsService, { profileId, enforcement });
  return enforcement;
}
