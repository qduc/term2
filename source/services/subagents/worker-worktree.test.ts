import { it, expect } from 'vitest';
import { getActiveWorkspaceRoot, publishActiveWorkspaceRoot } from '../workspace/active-workspace-root.js';
import { pinWorkerWorktree } from './worker-worktree.js';
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
