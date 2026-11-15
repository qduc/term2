import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSettingsDirectory } from '../../../config/settings/settings-path.js';
import { findGitCheckoutRoot, resolveGitWorktreeWritePaths } from './git-worktree-write-paths.js';

/** Identify the canonical checkout or the Git directory shared by registered worktrees. */
export function sandboxProjectKey(workspaceRoot: string): string {
  const root = fs.realpathSync(workspaceRoot);
  const gitDir = path.join(findGitCheckoutRoot(root) ?? root, '.git');
  const sharedDir = resolveGitWorktreeWritePaths(root).commonDir;
  const identity = sharedDir ?? (fs.lstatSync(gitDir, { throwIfNoEntry: false })?.isDirectory() ? gitDir : root);
  return createHash('sha256').update(identity).digest('hex');
}

export function sandboxUserStateRoot(): string {
  // Security state must not inherit a checkout-relative XDG_STATE_HOME.
  return resolveSettingsDirectory({
    homeDir: fs.existsSync(os.homedir()) ? fs.realpathSync(os.homedir()) : os.homedir(),
    env: {},
  });
}

/** Create the project-specific dependency cache only along trusted directory paths. */
export function prepareSandboxProjectCache(workspaceRoot: string): string | undefined {
  try {
    const directory = path.join(sandboxUserStateRoot(), 'sandbox-project-cache', sandboxProjectKey(workspaceRoot));
    let parent = directory;
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    if (fs.realpathSync(parent) !== parent) return undefined;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return fs.realpathSync(directory) === directory ? directory : undefined;
  } catch {
    return undefined;
  }
}
