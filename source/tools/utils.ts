import path from 'path';
import { homedir } from 'os';
import { z } from 'zod';

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
  },
): string {
  const allowOutsideWorkspace = options?.allowOutsideWorkspace ?? false;

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
    // Check if the path is in a safe temporary directory
    const isTempDir =
      normalizedResolved === '/tmp' ||
      normalizedResolved.startsWith('/tmp' + path.sep) ||
      normalizedResolved === '/private/tmp' ||
      normalizedResolved.startsWith('/private/tmp' + path.sep);

    if (isTempDir) {
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
