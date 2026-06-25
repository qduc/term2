import path from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { getDiscoveredSkillRoots } from '../utils/skill-discovery-paths.js';
import { SANDBOX_TEMP_DIR } from '../utils/shell/temp-dir.js';

/**
 * Resolves a relative path and ensures it's within the workspace
 */
export function resolveWorkspacePath(
  relativePath: string,
  baseDir: string = process.cwd(),
  options?: {
    /**
     * If true, resolve the path but do not enforce that it stays within baseDir.
     * Intended for Lite Mode read-only tools.
     */
    allowOutsideWorkspace?: boolean;
    /**
     * If true, paths under skill discovery directories are allowed even when outside baseDir.
     */
    allowDiscoveredSkillFolders?: boolean;
  },
): string {
  const allowOutsideWorkspace = options?.allowOutsideWorkspace ?? false;
  const allowDiscoveredSkillFolders = options?.allowDiscoveredSkillFolders ?? false;

  // Expand ~ if the path starts with it
  const expandedPath = relativePath.startsWith('~') ? relativePath.replace(/^~/, homedir()) : relativePath;

  const resolved = path.isAbsolute(expandedPath) ? path.normalize(expandedPath) : path.resolve(baseDir, expandedPath);

  if (allowOutsideWorkspace) {
    return resolved;
  }

  const normalizedBaseDir = path.resolve(baseDir);
  const normalizedResolved = path.resolve(resolved);

  // Ensure either exact match or within base directory (prefix with separator to avoid /foo/bar2 matching /foo/bar)
  const basePrefix = normalizedBaseDir.endsWith(path.sep) ? normalizedBaseDir : normalizedBaseDir + path.sep;
  let isInside = normalizedResolved === normalizedBaseDir || normalizedResolved.startsWith(basePrefix);

  if (!isInside) {
    // Check if the path is in the sandbox-specific temp directory.
    // Only the app's own temp dir is allowed — not the entire /tmp tree.
    const isTempDir =
      normalizedResolved === SANDBOX_TEMP_DIR || normalizedResolved.startsWith(SANDBOX_TEMP_DIR + path.sep);

    if (isTempDir) {
      isInside = true;
    }
  }

  if (!isInside && allowDiscoveredSkillFolders) {
    const isWithin = (targetPath: string, rootPath: string): boolean => {
      const normalizedRoot = path.resolve(rootPath);
      const rootPrefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
      return targetPath === normalizedRoot || targetPath.startsWith(rootPrefix);
    };

    const discoveredSkillRoots = getDiscoveredSkillRoots(normalizedBaseDir, homedir());

    if (discoveredSkillRoots.some((rootPath) => isWithin(normalizedResolved, rootPath))) {
      isInside = true;
    }
  }

  if (!isInside) {
    throw new Error(`Operation outside workspace: ${relativePath}`);
  }

  return normalizedResolved;
}

/**
 * A Zod schema that allows either a number or a string that can be parsed as a number.
 * Useful for tool parameters that might be passed as strings from the LLM.
 * Use with .int(), .positive(), etc. to add further constraints.
 */
export const relaxedNumber = z.coerce.number();
