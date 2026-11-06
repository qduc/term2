import os from 'os';
import path from 'path';

// Centralized list of skill scope directory names.
export const SKILL_SCOPE_DIRS = ['.term2', '.agents', '.claude'] as const;

export function getProjectSkillScopes(baseDir: string): string[] {
  return SKILL_SCOPE_DIRS.map((scopeDir) => path.join(baseDir, scopeDir, 'skills'));
}

export function getUserSkillScopes(homeDir?: string): string[] {
  const resolvedHome = homeDir ?? os.homedir();
  if (!resolvedHome) {
    return [];
  }

  return getProjectSkillScopes(resolvedHome);
}

export function getDiscoveredSkillRoots(baseDir: string, homeDir?: string): string[] {
  return [...getProjectSkillScopes(baseDir), ...getUserSkillScopes(homeDir)];
}
