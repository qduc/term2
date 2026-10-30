import { resolveProfile } from './resolver.js';
import { ProfileResolutionError } from './types.js';
const STANDARD_PROFILE_ID = 'builtin:standard';
const enforcementCache = new WeakMap();
const readActiveProfileId = (settingsService) => {
    const value = settingsService.get('app.activeProfileId');
    return typeof value === 'string' && value.trim().length > 0 ? value : STANDARD_PROFILE_ID;
};
export function resolveActiveProfile(settingsService, options) {
    return resolveProfile(readActiveProfileId(settingsService), options);
}
export function resolveActiveEnforcement(settingsService) {
    const profileId = readActiveProfileId(settingsService);
    const cached = enforcementCache.get(settingsService);
    if (cached?.profileId === profileId)
        return cached.enforcement;
    let enforcement;
    try {
        enforcement = resolveActiveProfile(settingsService).enforcement;
    }
    catch (error) {
        if (!(error instanceof ProfileResolutionError))
            throw error;
        enforcement = {
            policies: new Set(),
            denials: new Set(),
            handoffRestrictions: new Set(),
        };
    }
    enforcementCache.set(settingsService, { profileId, enforcement });
    return enforcement;
}
/** Version the selected profile composition without logging its instruction contents. */
export function getProfileMetadata(profileId) {
    const { identity } = resolveProfile(profileId);
    return {
        activeProfileId: identity.id,
        activeProfileVersion: identity.version,
        activeProfileDigest: identity.digest,
    };
}
//# sourceMappingURL=active-profile.js.map