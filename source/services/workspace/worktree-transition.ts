import path from 'path';
import type { GitWorktree } from './parse-worktree-list.js';

/** A background shell job still executing under the current root. */
export interface RunningJob {
  id: string;
  command: string;
}

export interface EnterWorktreeRequest {
  name: string;
  /** The session's home root; never an entry candidate. */
  homeRoot: string;
  worktrees: GitWorktree[];
  activeWorkspace: string | undefined;
  runningJobs: RunningJob[];
}

export type EnterWorktreeOutcome =
  | { kind: 'entered'; worktree: GitWorktree }
  | { kind: 'already_active'; worktree: GitWorktree }
  | { kind: 'not_found'; available: GitWorktree[] }
  | { kind: 'ambiguous'; candidates: GitWorktree[] }
  | { kind: 'unavailable'; worktree: GitWorktree }
  | { kind: 'busy'; jobs: RunningJob[] };

export interface ExitWorktreeRequest {
  homeRoot: string;
  activeWorkspace: string | undefined;
  runningJobs: RunningJob[];
}

export type ExitWorktreeOutcome =
  | { kind: 'exited'; homeRoot: string }
  | { kind: 'not_in_worktree'; homeRoot: string }
  | { kind: 'busy'; jobs: RunningJob[] };

/** Working trees the session may lease: everything but the home root and bare records. */
export function enterableWorktrees(worktrees: GitWorktree[], homeRoot: string): GitWorktree[] {
  return worktrees.filter((worktree) => !worktree.bare && worktree.path !== homeRoot);
}

/**
 * Decides an `enter_worktree` request without performing it.
 *
 * The name is resolved against a runtime-issued list rather than accepted as a
 * path, so a stale or invented path cannot retarget the session; and an
 * ambiguous name is refused rather than guessed, because guessing wrong means
 * silently writing into the wrong checkout.
 */
export function resolveEnterWorktree(request: EnterWorktreeRequest): EnterWorktreeOutcome {
  const { name, homeRoot, worktrees, activeWorkspace, runningJobs } = request;
  const candidates = enterableWorktrees(worktrees, homeRoot);

  const byBranch = candidates.filter((worktree) => worktree.branch === name);
  // A branch name is an exact, repo-unique identifier; a directory name is not,
  // so it only decides the match when no branch claims the name.
  const matches = byBranch.length > 0 ? byBranch : candidates.filter((w) => path.basename(w.path) === name);

  if (matches.length === 0) {
    return { kind: 'not_found', available: candidates.filter((worktree) => !worktree.prunable) };
  }
  if (matches.length > 1) {
    return { kind: 'ambiguous', candidates: matches };
  }

  const [match] = matches;
  if (match.prunable) {
    return { kind: 'unavailable', worktree: match };
  }
  if (activeWorkspace === match.path) {
    return { kind: 'already_active', worktree: match };
  }
  if (runningJobs.length > 0) {
    return { kind: 'busy', jobs: runningJobs };
  }
  return { kind: 'entered', worktree: match };
}

/** Decides an `exit_worktree` request without performing it. */
export function resolveExitWorktree(request: ExitWorktreeRequest): ExitWorktreeOutcome {
  const { homeRoot, activeWorkspace, runningJobs } = request;

  if (!activeWorkspace) {
    return { kind: 'not_in_worktree', homeRoot };
  }
  if (runningJobs.length > 0) {
    return { kind: 'busy', jobs: runningJobs };
  }
  return { kind: 'exited', homeRoot };
}
