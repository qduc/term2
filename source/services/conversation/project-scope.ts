import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Session scope identity. A session belongs to the git project that owns the
 * directory it was persisted under, so a project's root checkout and all of
 * its worktrees share one scope — the same identity persistent memory uses
 * (`git rev-parse --git-common-dir`). Every scope comparison, in persistence
 * and in the session index, must go through {@link projectScopeKey}: separate
 * call sites choosing their own root is how rotated sessions once became
 * invisible to their own process.
 */

export function normalizeProjectPath(projectPath: string): string {
  const normalized = path.normalize(projectPath);
  return normalized.endsWith(path.sep) && normalized !== path.sep ? normalized.slice(0, -1) : normalized;
}

/** The git common dir for `dir`, or null when `dir` is not (or no longer) inside a repository. */
export type GitCommonDirLookup = (dir: string) => string | null;

function readGitCommonDir(dir: string): string | null {
  try {
    return (
      execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    // Not a repository, git unavailable, or the directory no longer exists.
    return null;
  }
}

const WORKTREES_SEGMENT = `${path.sep}.worktrees${path.sep}`;

/**
 * Worktrees are removed after merge, so git can no longer place their
 * historical sessions. term2 creates them under `<project>/.worktrees/` (the
 * shell sandbox only permits writes there), which still identifies the owner.
 */
function worktreeConventionRoot(normalized: string): string | null {
  const index = normalized.indexOf(WORKTREES_SEGMENT);
  return index > 0 ? normalized.slice(0, index) : null;
}

export function createProjectScopeResolver(gitCommonDir: GitCommonDirLookup = readGitCommonDir) {
  const cache = new Map<string, string>();
  return (projectPath: string, sshHost?: string): string => {
    const normalized = normalizeProjectPath(projectPath);
    // A remote path names a directory on another machine; local git cannot place it.
    if (sshHost) return normalized;
    const cached = cache.get(normalized);
    if (cached !== undefined) return cached;
    const commonDir = gitCommonDir(normalized);
    const key = commonDir
      ? normalizeProjectPath(path.dirname(path.resolve(normalized, commonDir)))
      : worktreeConventionRoot(normalized) ?? normalized;
    cache.set(normalized, key);
    return key;
  };
}

export const projectScopeKey = createProjectScopeResolver();
