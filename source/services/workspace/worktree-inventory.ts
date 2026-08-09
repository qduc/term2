import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { parseWorktreeList, type GitWorktree } from './parse-worktree-list.js';

const execFileAsync = promisify(execFile);

export type ListWorktrees = (repoRoot: string) => Promise<GitWorktree[]>;

/**
 * Lists the repository's working trees with each path realpath-resolved, so
 * comparisons against the execution root are not defeated by symlinked
 * checkouts (a real case on macOS, where /tmp is a symlink).
 */
export const listGitWorktrees: ListWorktrees = async (repoRoot) => {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });

  const worktrees = parseWorktreeList(stdout);
  return Promise.all(
    worktrees.map(async (worktree) => {
      try {
        return { ...worktree, path: await fs.realpath(worktree.path) };
      } catch {
        // A prunable worktree's directory may be gone; keep the recorded path
        // so the tool can still report it as unavailable.
        return worktree;
      }
    }),
  );
};

export type { GitWorktree };
