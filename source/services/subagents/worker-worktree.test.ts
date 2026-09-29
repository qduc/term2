import { it, expect } from 'vitest';
import { getActiveWorkspaceRoot, publishActiveWorkspaceRoot } from '../workspace/active-workspace-root.js';
import { pinWorkerWorktree, deriveAuthorizedWorktreeScope } from './worker-worktree.js';
import type { GitWorktree } from '../workspace/parse-worktree-list.js';

const HOME = '/repo';
const FEATURE: GitWorktree = {
  path: '/repo/.worktrees/feature',
  branch: 'feature',
  detached: false,
  bare: false,
  locked: false,
  prunable: false,
};

const list = async () => [
  { path: HOME, branch: 'main', detached: false, bare: false, locked: false, prunable: false },
  FEATURE,
];

it('pins a worker into an existing worktree without publishing the active root', async () => {
  publishActiveWorkspaceRoot(undefined);
  const before = getActiveWorkspaceRoot();
  const result = await pinWorkerWorktree({
    name: 'feature',
    role: 'worker',
    homeRoot: HOME,
    isRemote: false,
    listWorktrees: list,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.worktreePath).toBe(FEATURE.path);
  expect(result.executionContext.getCwd()).toBe(FEATURE.path);
  expect(getActiveWorkspaceRoot()).toBe(before);
});

it('pins a generic agent invocation into the requested existing worktree', async () => {
  const result = await pinWorkerWorktree({
    name: 'feature',
    role: 'agent',
    homeRoot: HOME,
    isRemote: false,
    listWorktrees: list,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.executionContext.getCwd()).toBe(FEATURE.path);
});

it('rejects non-worker roles', async () => {
  const result = await pinWorkerWorktree({
    name: 'feature',
    role: 'explorer',
    homeRoot: HOME,
    isRemote: false,
    listWorktrees: list,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/only supported for role "worker"/i);
});

it('rejects remote sessions', async () => {
  const result = await pinWorkerWorktree({
    name: 'feature',
    role: 'worker',
    homeRoot: HOME,
    isRemote: true,
    listWorktrees: list,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/remote/i);
});

it('returns a clear error for an unknown worktree name', async () => {
  const result = await pinWorkerWorktree({
    name: 'missing',
    role: 'worker',
    homeRoot: HOME,
    isRemote: false,
    listWorktrees: list,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/Unknown worktree "missing"/);
  expect(result.error).toMatch(/feature/);
});

it('deriveAuthorizedWorktreeScope derives allowlist for registered in-repo worktrees and excludes outside/homeRoot/prunable/bare', () => {
  const outside: GitWorktree = {
    path: '/outside/tree',
    branch: 'outside-branch',
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
  };
  const prunable: GitWorktree = {
    path: '/repo/.worktrees/pruned',
    branch: 'pruned-branch',
    detached: false,
    bare: false,
    locked: false,
    prunable: true,
  };
  const bare: GitWorktree = {
    path: '/repo/.worktrees/bare',
    branch: 'bare-branch',
    detached: false,
    bare: true,
    locked: false,
    prunable: false,
  };
  const allTrees: GitWorktree[] = [
    { path: HOME, branch: 'main', detached: false, bare: false, locked: false, prunable: false },
    FEATURE,
    outside,
    prunable,
    bare,
  ];

  const scope = deriveAuthorizedWorktreeScope({
    homeRoot: HOME,
    worktrees: allTrees,
  });

  // Allowed: 'feature' (both basename and branch match 'feature')
  expect(scope).toContain('feature');
  // Excluded: homeRoot ('main', 'repo'), outside ('outside-branch', 'tree'), prunable, bare
  expect(scope).not.toContain('main');
  expect(scope).not.toContain('repo');
  expect(scope).not.toContain('outside-branch');
  expect(scope).not.toContain('tree');
  expect(scope).not.toContain('pruned-branch');
  expect(scope).not.toContain('pruned');
  expect(scope).not.toContain('bare-branch');
  expect(scope).not.toContain('bare');
});

it('deriveAuthorizedWorktreeScope excludes ambiguous directory names', () => {
  const tree1: GitWorktree = {
    path: '/repo/.worktrees/a/conflict',
    branch: 'branch-a',
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
  };
  const tree2: GitWorktree = {
    path: '/repo/.worktrees/b/conflict',
    branch: 'branch-b',
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
  };
  const worktrees = [
    { path: HOME, branch: 'main', detached: false, bare: false, locked: false, prunable: false },
    tree1,
    tree2,
  ];

  const scope = deriveAuthorizedWorktreeScope({
    homeRoot: HOME,
    worktrees,
  });

  // Basename 'conflict' is ambiguous between tree1 and tree2, so it must not be admitted
  expect(scope).not.toContain('conflict');
  // But unique branch names are admitted
  expect(scope).toContain('branch-a');
  expect(scope).toContain('branch-b');
});

it('deriveAuthorizedWorktreeScope fails closed when remote, read-only, or plan mode is true', () => {
  const worktrees = [
    { path: HOME, branch: 'main', detached: false, bare: false, locked: false, prunable: false },
    FEATURE,
  ];

  expect(deriveAuthorizedWorktreeScope({ homeRoot: HOME, isRemote: true, worktrees })).toEqual([]);
  expect(deriveAuthorizedWorktreeScope({ homeRoot: HOME, readOnly: true, worktrees })).toEqual([]);
  expect(deriveAuthorizedWorktreeScope({ homeRoot: HOME, planMode: true, worktrees })).toEqual([]);
});

it('deriveAuthorizedWorktreeScope fails closed when worktree listing fails or is empty', () => {
  expect(
    deriveAuthorizedWorktreeScope({
      homeRoot: HOME,
      listWorktreesSync: () => {
        throw new Error('git error');
      },
    }),
  ).toEqual([]);
  expect(deriveAuthorizedWorktreeScope({ homeRoot: HOME, worktrees: [] })).toEqual([]);
});

it('deriveAuthorizedWorktreeScope retains immutable authorized path identity alongside each allowed name', () => {
  const scope = deriveAuthorizedWorktreeScope({
    homeRoot: HOME,
    worktrees: [{ path: HOME, branch: 'main', detached: false, bare: false, locked: false, prunable: false }, FEATURE],
  });

  expect(scope).toContain('feature');
  expect((scope as any).authorizedPaths).toEqual({
    feature: FEATURE.path,
  });
});

it('pinWorkerWorktree succeeds when freshly resolved worktree matches authorizedPath', async () => {
  const result = await pinWorkerWorktree({
    name: 'feature',
    role: 'agent',
    homeRoot: HOME,
    isRemote: false,
    listWorktrees: list,
    authorizedPath: FEATURE.path,
  } as any);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.worktreePath).toBe(FEATURE.path);
});

it('pinWorkerWorktree fails closed when freshly resolved worktree does not match authorizedPath (moved tree)', async () => {
  const movedList = async () => [
    { path: HOME, branch: 'main', detached: false, bare: false, locked: false, prunable: false },
    { path: '/outside/moved-feature', branch: 'feature', detached: false, bare: false, locked: false, prunable: false },
  ];

  const result = await pinWorkerWorktree({
    name: 'feature',
    role: 'agent',
    homeRoot: HOME,
    isRemote: false,
    listWorktrees: movedList,
    authorizedPath: FEATURE.path,
  } as any);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/does not match authorized path/);
});
