import { it, expect } from 'vitest';
import {
  resolveEnterWorktree,
  resolveExitWorktree,
  resolveWorkerWorktree,
  type RunningJob,
} from './worktree-transition.js';
import type { GitWorktree } from './parse-worktree-list.js';

const HOME = '/repo';

function worktree(overrides: Partial<GitWorktree> & Pick<GitWorktree, 'path'>): GitWorktree {
  return { detached: false, bare: false, locked: false, prunable: false, ...overrides };
}

const home = worktree({ path: HOME, branch: 'main' });
const feature = worktree({ path: '/repo/.worktrees/feature', branch: 'feature' });
const fix = worktree({ path: '/repo/.worktrees/fix', branch: 'codex/fix-thing' });

function enter(name: string, options: Partial<Parameters<typeof resolveEnterWorktree>[0]> = {}) {
  return resolveEnterWorktree({
    name,
    homeRoot: HOME,
    worktrees: [home, feature, fix],
    activeWorkspace: undefined,
    runningJobs: [],
    ...options,
  });
}

it('enters a worktree matched by directory name', () => {
  expect(enter('feature')).toEqual({ kind: 'entered', worktree: feature });
});

it('enters a worktree matched by its branch name', () => {
  expect(enter('codex/fix-thing')).toEqual({ kind: 'entered', worktree: fix });
});

it('reports the available worktrees when the name is unknown', () => {
  const result = enter('nope');
  expect(result.kind).toBe('not_found');
  expect(result.kind === 'not_found' && result.available).toEqual([feature, fix]);
});

it('excludes the home worktree from entry, since exit_worktree is the only way back', () => {
  const result = enter('repo');
  expect(result.kind).toBe('not_found');
  expect(result.kind === 'not_found' && result.available.map((w) => w.path)).not.toContain(HOME);
});

it('refuses an ambiguous directory name rather than guessing a tree to write into', () => {
  const one = worktree({ path: '/repo/.worktrees/a/feature', branch: 'team-a-feature' });
  const two = worktree({ path: '/repo/.worktrees/b/feature', branch: 'team-b-feature' });
  const result = enter('feature', { worktrees: [home, one, two] });
  expect(result.kind).toBe('ambiguous');
  expect(result.kind === 'ambiguous' && result.candidates.map((w) => w.path)).toEqual([one.path, two.path]);
});

it('prefers an exact branch match over an ambiguous directory-name match', () => {
  const shadow = worktree({ path: '/repo/.worktrees/elsewhere', branch: 'feature' });
  const result = enter('feature', { worktrees: [home, shadow, worktree({ path: '/repo/.worktrees/feature' })] });
  expect(result).toEqual({ kind: 'entered', worktree: shadow });
});

it('refuses a worktree whose directory is gone', () => {
  const gone = worktree({ path: '/repo/.worktrees/gone', branch: 'gone', prunable: true });
  expect(enter('gone', { worktrees: [home, gone] })).toEqual({ kind: 'unavailable', worktree: gone });
});

it('excludes bare records, which have no working tree to enter', () => {
  const bare = worktree({ path: '/repo.git', bare: true });
  const result = enter('repo.git', { worktrees: [home, bare] });
  expect(result.kind).toBe('not_found');
});

it('reports already_active when the requested worktree is the active one', () => {
  expect(enter('feature', { activeWorkspace: feature.path })).toEqual({ kind: 'already_active', worktree: feature });
});

it('switches directly from one worktree to another', () => {
  expect(enter('fix', { activeWorkspace: feature.path })).toEqual({ kind: 'entered', worktree: fix });
});

it('refuses to enter while background jobs are still running under the current root', () => {
  const jobs: RunningJob[] = [{ id: 'job-1', command: 'pnpm test' }];
  expect(enter('feature', { runningJobs: jobs })).toEqual({ kind: 'busy', jobs });
});

it('exits an active worktree back to the home root', () => {
  expect(resolveExitWorktree({ activeWorkspace: feature.path, homeRoot: HOME, runningJobs: [] })).toEqual({
    kind: 'exited',
    homeRoot: HOME,
  });
});

it('reports not_in_worktree when no workspace is active', () => {
  expect(resolveExitWorktree({ activeWorkspace: undefined, homeRoot: HOME, runningJobs: [] })).toEqual({
    kind: 'not_in_worktree',
    homeRoot: HOME,
  });
});

it('refuses to exit while background jobs are still running under the worktree', () => {
  const jobs: RunningJob[] = [{ id: 'job-1', command: 'pnpm build' }];
  expect(resolveExitWorktree({ activeWorkspace: feature.path, homeRoot: HOME, runningJobs: jobs })).toEqual({
    kind: 'busy',
    jobs,
  });
});

it('resolveWorkerWorktree resolves by directory name without busy checks', () => {
  expect(resolveWorkerWorktree('feature', HOME, [home, feature, fix])).toEqual({
    kind: 'resolved',
    worktree: feature,
  });
});

it('resolveWorkerWorktree resolves by branch name', () => {
  expect(resolveWorkerWorktree('codex/fix-thing', HOME, [home, feature, fix])).toEqual({
    kind: 'resolved',
    worktree: fix,
  });
});

it('resolveWorkerWorktree reports not_found with available trees', () => {
  const result = resolveWorkerWorktree('nope', HOME, [home, feature, fix]);
  expect(result.kind).toBe('not_found');
  expect(result.kind === 'not_found' && result.available).toEqual([feature, fix]);
});

it('resolveWorkerWorktree refuses ambiguous directory names', () => {
  const one = worktree({ path: '/repo/.worktrees/a/feature', branch: 'team-a-feature' });
  const two = worktree({ path: '/repo/.worktrees/b/feature', branch: 'team-b-feature' });
  const result = resolveWorkerWorktree('feature', HOME, [home, one, two]);
  expect(result.kind).toBe('ambiguous');
  expect(result.kind === 'ambiguous' && result.candidates.map((w) => w.path)).toEqual([one.path, two.path]);
});

it('resolveWorkerWorktree refuses a prunable worktree', () => {
  const gone = worktree({ path: '/repo/.worktrees/gone', branch: 'gone', prunable: true });
  expect(resolveWorkerWorktree('gone', HOME, [home, gone])).toEqual({ kind: 'unavailable', worktree: gone });
});
