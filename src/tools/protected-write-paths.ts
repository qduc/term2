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
 * - `.git/hooks` and `.git/config` of the checkout, and of the shared git
 *   directory of a linked worktree: they run code on the user's next git command.
 */
export type ProtectedWriteKind = 'hooks' | 'term2-settings' | 'git-hooks' | 'git-config';

function protectedWriteKind(
  targetPath: string,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ProtectedWriteKind | undefined {
  const candidates = new Set([path.resolve(targetPath), physicalPath(path.resolve(targetPath))]);
  const workspace = path.resolve(workspaceRoot);
  const roots = protectedRoots(workspace, env);
  for (const candidate of candidates) {
    for (const [kind, entries] of roots) {
      if (entries.some((entry) => candidate === entry || candidate.startsWith(entry + path.sep))) return kind;
    }
  }
  return undefined;
}

function protectedRoots(workspace: string, env: NodeJS.ProcessEnv): Array<[ProtectedWriteKind, string[]]> {
  const home = homedir();
  const checkout = findGitCheckoutRoot(workspace) ?? workspace;
  const gitDirs = [path.join(checkout, '.git')];
  const commonDir = resolveGitWorktreeWritePaths(workspace).commonDir;
  if (commonDir) gitDirs.push(commonDir);
  const withPhysical = (entries: string[]) =>
    Array.from(new Set(entries.flatMap((entry) => [path.resolve(entry), physicalPath(path.resolve(entry))])));
  return [
    ['hooks', withPhysical([path.join(home, '.term2', 'hooks'), path.join(workspace, '.term2', 'hooks')])],
    [
      'term2-settings',
      withPhysical(
        [
          resolveSettingsDirectory({ env }),
          resolveSettingsDirectory({ env: {} }),
          env.TERM2_CONFIG_DIR,
          envPaths('term2').config,
          path.join(workspace, '.term2', 'sandbox-allow-paths.json'),
        ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0),
      ),
    ],
    ['git-hooks', withPhysical(gitDirs.map((dir) => path.join(dir, 'hooks')))],
    ['git-config', withPhysical(gitDirs.map((dir) => path.join(dir, 'config')))],
  ];
}

/** The path with its nearest existing ancestor's symlinks resolved, so a link cannot redirect a write. */
function physicalPath(target: string): string {
  let existing = target;
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return target;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync(existing), ...rest);
  } catch {
    return target;
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
