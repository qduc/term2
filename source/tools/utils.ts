import path from 'path';
import { homedir } from 'os';
import { lstat, realpath } from 'fs/promises';
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
 * Resolve a path through the filesystem without requiring the final target to
 * exist. Existing targets are fully realpathed; for a missing target, the
 * nearest existing ancestor is realpathed and the missing suffix is appended.
 * A dangling symlink (or any other filesystem resolution error) is rejected.
 */
async function resolvePhysicalPath(targetPath: string): Promise<string | undefined> {
  let candidate = path.resolve(targetPath);
  const missingSuffix: string[] = [];

  while (true) {
    try {
      const resolvedAncestor = await realpath(candidate);
      return path.join(resolvedAncestor, ...missingSuffix.reverse());
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        return undefined;
      }

      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return undefined;
      }

      // lstat distinguishes a dangling symlink from a merely missing target.
      // If the candidate itself is a symlink, realpath above would have failed
      // and we must fail closed rather than treat its parent as the target.
      try {
        const stats = await lstat(candidate);
        if (stats.isSymbolicLink()) {
          return undefined;
        }
      } catch (lstatError: any) {
        if (lstatError?.code !== 'ENOENT' && lstatError?.code !== 'ENOTDIR') {
          return undefined;
        }
      }

      missingSuffix.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * Whether a filesystem write resolves physically within the workspace.
 *
 * This is intentionally separate from resolveWorkspacePath: lexical
 * containment is still used to preserve explicit approval for outside paths,
 * while this check prevents an apparently-inside path from auto-approving a
 * write through a symlink. Missing create-file paths are safe when their
 * nearest existing ancestor resolves inside the workspace.
 */
export async function isWorkspacePathPhysicallyInside(targetPath: string, workspaceRoot: string): Promise<boolean> {
  const [physicalTarget, physicalWorkspace] = await Promise.all([
    resolvePhysicalPath(targetPath),
    resolvePhysicalPath(workspaceRoot),
  ]);

  if (!physicalTarget || !physicalWorkspace) {
    return false;
  }

  const workspacePrefix = physicalWorkspace.endsWith(path.sep) ? physicalWorkspace : `${physicalWorkspace}${path.sep}`;
  return physicalTarget === physicalWorkspace || physicalTarget.startsWith(workspacePrefix);
}

/**
 * Hook files are executable, trusted in-process code.  A model write to one
 * must therefore remain explicitly approved even when the hook directory is
 * physically inside the active workspace.  Keep this check independent of
 * hook loading/trust: trusting a project permits execution, never silent model
 * mutation.
 */
export function isProtectedHookPath(targetPath: string, workspaceRoot: string = process.cwd()): boolean {
  const normalizedTarget = path.resolve(targetPath);
  const roots = [path.join(homedir(), '.term2', 'hooks'), path.join(path.resolve(workspaceRoot), '.term2', 'hooks')];
  return roots.some((root) => {
    const normalizedRoot = path.resolve(root);
    const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(prefix);
  });
}

/**
 * A Zod schema that allows either a number or a string that can be parsed as a number.
 * Useful for tool parameters that might be passed as strings from the LLM.
 * Use with .int(), .positive(), etc. to add further constraints.
 */
export const relaxedNumber = z.coerce.number();
