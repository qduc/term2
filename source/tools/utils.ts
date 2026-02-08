import path from 'path';
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
  const resolved = path.isAbsolute(relativePath) ? path.normalize(relativePath) : path.resolve(baseDir, relativePath);

  if (allowOutsideWorkspace) {
    return resolved;
  }

  const normalizedBaseDir = path.resolve(baseDir);
  const normalizedResolved = path.resolve(resolved);

  // Ensure either exact match or within base directory (prefix with separator to avoid /foo/bar2 matching /foo/bar)
  const basePrefix = normalizedBaseDir.endsWith(path.sep) ? normalizedBaseDir : normalizedBaseDir + path.sep;
  const isInside = normalizedResolved === normalizedBaseDir || normalizedResolved.startsWith(basePrefix);

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
