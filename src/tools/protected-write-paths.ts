import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import envPaths from 'env-paths';
import { resolveSettingsDirectory } from '../config/settings/settings-path.js';
import { parseUpstreamApplyPatch } from '../shared/utils/upstream-apply-patch.js';
import { readSearchReplaceArguments } from './file/search-replace-protocol.js';
import { findGitCheckoutRoot, resolveGitWorktreeWritePaths } from './shell/sandbox/git-worktree-write-paths.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE, TOOL_NAME_SEARCH_REPLACE } from './tool-names.js';
import { expandHome } from './workspace/path-identity.js';

/**
 * Writes that change who checks the agent's work: the approval floor
 * (docs/plans/approvals-and-sandbox/headless-approval-redesign.md, decision 3).
 * A write to one of these is never automatic in any approval mode, `always`
 * included: a person is asked, or the request is refused when nobody is present.
 *
 * - `.term2/hooks` (user and project): trusted in-process code.
 * - Term2's settings and config directories, and the project's
 *   `.term2/sandbox-allow-paths.json`: approval mode, sandbox switch, remembered
 *   read grants, credentials.
 * - `.git/hooks`, `.git/config` and `config.worktree` of the checkout, of the
 *   shared git directory of a linked worktree, and of submodules under
 *   `.git/modules`: they run code on the user's next git command. Hook
 *   directories named by `core.hooksPath` (such as `.husky`) are not covered.
 */
export type ProtectedWriteKind = 'hooks' | 'term2-settings' | 'git-hooks' | 'git-config';

/** A submodule's or a linked worktree's own hooks and config, wherever its git directory is. */
const NESTED_GIT_CONTROL =
  /[\\/]\.git[\\/](?:modules[\\/].+[\\/](?:hooks|config|config\.worktree)|worktrees[\\/][^\\/]+[\\/]config\.worktree)(?:[\\/]|$)/;

function protectedWriteKind(
  targetPath: string,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ProtectedWriteKind | undefined {
  // macOS and Windows file systems ignore case by default, so `.GIT/hooks` names the same directory.
  const fold =
    process.platform === 'darwin' || process.platform === 'win32' ? (p: string) => p.toLowerCase() : (p: string) => p;
  const candidates = new Set([path.resolve(targetPath), physicalPath(path.resolve(targetPath))].map(fold));
  const roots = protectedRoots(path.resolve(workspaceRoot), env);
  for (const candidate of candidates) {
    for (const [kind, entries] of roots) {
      if (entries.some((entry) => candidate === fold(entry) || candidate.startsWith(fold(entry) + path.sep)))
        return kind;
    }
    const nested = NESTED_GIT_CONTROL.exec(candidate);
    if (nested) return nested[0].includes('hooks') ? 'git-hooks' : 'git-config';
  }
  return undefined;
}

function protectedRoots(workspace: string, env: NodeJS.ProcessEnv): Array<[ProtectedWriteKind, string[]]> {
  const home = homedir();
  const checkout = findGitCheckoutRoot(workspace) ?? workspace;
  const linked = resolveGitWorktreeWritePaths(workspace);
  const gitDirs = [path.join(checkout, '.git')];
  // Projects whose `.term2` the floor covers: this checkout and, for a linked worktree (a worker pinned to
  // one, say), the main checkout that owns the shared git directory.
  const projects = [workspace, checkout];
  if (linked.commonDir) {
    gitDirs.push(linked.commonDir);
    if (path.basename(linked.commonDir) === '.git') projects.push(path.dirname(linked.commonDir));
  }
  const worktreeConfigs = linked.commonDir && linked.read[0] ? [path.join(linked.read[0], 'config.worktree')] : [];
  const withPhysical = (entries: string[]) =>
    Array.from(new Set(entries.flatMap((entry) => [path.resolve(entry), physicalPath(path.resolve(entry))])));
  return [
    [
      'hooks',
      withPhysical([path.join(home, '.term2', 'hooks'), ...projects.map((root) => path.join(root, '.term2', 'hooks'))]),
    ],
    [
      'term2-settings',
      withPhysical(
        [
          resolveSettingsDirectory({ env }),
          resolveSettingsDirectory({ env: {} }),
          env.TERM2_CONFIG_DIR,
          envPaths('term2').config,
          ...projects.map((root) => path.join(root, '.term2', 'sandbox-allow-paths.json')),
        ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0),
      ),
    ],
    ['git-hooks', withPhysical(gitDirs.map((dir) => path.join(dir, 'hooks')))],
    [
      'git-config',
      withPhysical([
        ...gitDirs.flatMap((dir) => [path.join(dir, 'config'), path.join(dir, 'config.worktree')]),
        ...worktreeConfigs,
      ]),
    ],
  ];
}

/** Whether anything, a dangling link included, is at `target`; a path through a file (ENOTDIR) is not. */
function lexists(target: string): boolean {
  try {
    return fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

/**
 * The path a write would land on: symlinks resolved along the existing part, and a dangling symlink followed
 * to where it points, so neither a link nor a not-yet-existing link target can redirect a write.
 */
function physicalPath(target: string, depth = 0): string {
  if (depth > 32) return target;
  let existing = target;
  const rest: string[] = [];
  while (!lexists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return target;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync(existing), ...rest);
  } catch {
    // A dangling link (or a chain ending in one): follow its text from the link's own physical directory.
    try {
      const pointee = path.resolve(physicalPath(path.dirname(existing), depth + 1), fs.readlinkSync(existing));
      return physicalPath(path.join(pointee, ...rest), depth + 1);
    } catch {
      return target;
    }
  }
}

/**
 * The first floor write a file tool call would make, or undefined. Reads the
 * call's own arguments, so the tool's approval check and the approval route
 * agree: `create_file` and `search_replace` name a `path`; `apply_patch` names
 * each operation's path and move target. Unparseable input yields undefined;
 * the tool's own checks still apply.
 */
export function protectedWriteForFileTool(
  toolName: string,
  input: unknown,
  cwd: string,
): { kind: ProtectedWriteKind; path: string } | undefined {
  for (const target of fileToolWriteTargets(toolName, input)) {
    const resolved = path.resolve(cwd, expandHome(target));
    const kind = protectedWriteKind(resolved, cwd);
    if (kind) return { kind, path: resolved };
  }
  return undefined;
}

function fileToolWriteTargets(toolName: string, input: unknown): string[] {
  try {
    const args = (typeof input === 'string' ? JSON.parse(input) : input) as Record<string, unknown> | null;
    if (!args || typeof args !== 'object') return [];
    if (toolName === TOOL_NAME_APPLY_PATCH) {
      if (typeof args.patch !== 'string') return [];
      return parseUpstreamApplyPatch(args.patch).operations.flatMap((operation) =>
        operation.type === 'update_file' && operation.moveTo ? [operation.path, operation.moveTo] : [operation.path],
      );
    }
    if (toolName === TOOL_NAME_CREATE_FILE || toolName === TOOL_NAME_SEARCH_REPLACE) {
      const normalized = (toolName === TOOL_NAME_SEARCH_REPLACE ? readSearchReplaceArguments(args) : args) as Record<
        string,
        unknown
      >;
      return typeof normalized?.path === 'string' ? [normalized.path] : [];
    }
  } catch {
    return [];
  }
  return [];
}
