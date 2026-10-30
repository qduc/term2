import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import fsSync from 'fs';
import { parseWorktreeList } from './parse-worktree-list.js';
const execFileAsync = promisify(execFile);
/**
 * Lists the repository's working trees synchronously with each path
 * realpath-resolved. Fails closed (returns empty array) on error or non-git root.
 */
export const listGitWorktreesSync = (repoRoot) => {
    let stdout;
    try {
        stdout = execFileSync('git', ['worktree', 'list', '--porcelain'], {
            cwd: repoRoot,
            maxBuffer: 1024 * 1024,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    }
    catch {
        return [];
    }
    const worktrees = parseWorktreeList(stdout);
    return worktrees.map((worktree) => {
        try {
            return { ...worktree, path: fsSync.realpathSync(worktree.path) };
        }
        catch {
            return worktree;
        }
    });
};
/**
 * Lists the repository's working trees with each path realpath-resolved, so
 * comparisons against the execution root are not defeated by symlinked
 * checkouts (a real case on macOS, where /tmp is a symlink).
 */
export const listGitWorktrees = async (repoRoot) => {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoRoot,
        maxBuffer: 1024 * 1024,
    });
    const worktrees = parseWorktreeList(stdout);
    return Promise.all(worktrees.map(async (worktree) => {
        try {
            return { ...worktree, path: await fs.realpath(worktree.path) };
        }
        catch {
            // A prunable worktree's directory may be gone; keep the recorded path
            // so the tool can still report it as unavailable.
            return worktree;
        }
    }));
};
//# sourceMappingURL=worktree-inventory.js.map