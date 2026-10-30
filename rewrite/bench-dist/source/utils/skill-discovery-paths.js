import os from 'os';
import path from 'path';
// Centralized list of skill scope directory names.
export const SKILL_SCOPE_DIRS = ['.term2', '.agents', '.claude'];
export function getProjectSkillScopes(baseDir) {
    return SKILL_SCOPE_DIRS.map((scopeDir) => path.join(baseDir, scopeDir, 'skills'));
}
export function getUserSkillScopes(homeDir) {
    const resolvedHome = homeDir ?? os.homedir();
    if (!resolvedHome) {
        return [];
    }
    return getProjectSkillScopes(resolvedHome);
}
export function getDiscoveredSkillRoots(baseDir, homeDir) {
    return [...getProjectSkillScopes(baseDir), ...getUserSkillScopes(homeDir)];
}
//# sourceMappingURL=skill-discovery-paths.js.map