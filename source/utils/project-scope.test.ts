import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createProjectScopeResolver, projectScopeKey, readGitCommonDir } from './project-scope.js';

// Pass-through spy: the real-git tests below still spawn git.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

let tempRoot: string | undefined;
afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

it('keys a live worktree by the project root that owns its git common dir', () => {
  const resolve = createProjectScopeResolver((dir) => (dir === '/repo/.worktrees/feature' ? '/repo/.git' : null));

  expect(resolve('/repo/.worktrees/feature')).toBe('/repo');
});

it('resolves a relative git common dir against the session path', () => {
  const resolve = createProjectScopeResolver(() => '.git');

  expect(resolve('/repo/')).toBe('/repo');
});

it('keys a deleted .worktrees checkout by the project that contained it', () => {
  const resolve = createProjectScopeResolver(() => null);

  expect(resolve('/repo/.worktrees/merged-and-removed')).toBe('/repo');
  expect(resolve('/repo/.worktrees/merged-and-removed/source')).toBe('/repo');
});

it('keys a path outside any repository by the normalized path itself', () => {
  const resolve = createProjectScopeResolver(() => null);

  expect(resolve('/scratch/notes/')).toBe('/scratch/notes');
});

it('never consults local git for a remote session path', () => {
  const gitCommonDir = vi.fn(() => '/local/.git');
  const resolve = createProjectScopeResolver(gitCommonDir);

  expect(resolve('/srv/app/.worktrees/x', 'host')).toBe('/srv/app/.worktrees/x');
  expect(gitCommonDir).not.toHaveBeenCalled();
});

it('asks git once per distinct path', () => {
  const gitCommonDir = vi.fn(() => '/repo/.git');
  const resolve = createProjectScopeResolver(gitCommonDir);

  resolve('/repo/a');
  resolve('/repo/a/');
  resolve('/repo/b');

  expect(gitCommonDir).toHaveBeenCalledTimes(2);
});

it('keys a real git worktree and its main checkout identically', () => {
  tempRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'project-scope-')));
  const repo = path.join(tempRoot, 'repo');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const worktree = path.join(tempRoot, 'elsewhere-worktree');
  git('worktree', 'add', '-q', worktree);

  expect(projectScopeKey(worktree)).toBe(repo);
  expect(projectScopeKey(repo)).toBe(repo);
});

it('does not spawn git for a session directory that no longer exists', () => {
  // Most historical session paths are merged-and-removed worktrees; scoping
  // them must not block the UI on one git process each.
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'project-scope-'));
  vi.mocked(execFileSync).mockClear();

  expect(readGitCommonDir(path.join(tempRoot, 'removed-worktree'))).toBeNull();
  expect(execFileSync).not.toHaveBeenCalled();
});
