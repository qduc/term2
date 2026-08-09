import { it, expect } from 'vitest';
import { parseWorktreeList } from './parse-worktree-list.js';

it('parses a single worktree record', () => {
  const output = ['worktree /repo', 'HEAD abc123', 'branch refs/heads/main', ''].join('\n');

  expect(parseWorktreeList(output)).toEqual([
    { path: '/repo', head: 'abc123', branch: 'main', detached: false, bare: false, locked: false, prunable: false },
  ]);
});

it('parses multiple records separated by blank lines', () => {
  const output = [
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo/.worktrees/feature',
    'HEAD def456',
    'branch refs/heads/feature',
    '',
  ].join('\n');

  expect(parseWorktreeList(output).map((w) => w.path)).toEqual(['/repo', '/repo/.worktrees/feature']);
});

it('marks a detached worktree and leaves its branch undefined', () => {
  const output = ['worktree /repo/.worktrees/detached', 'HEAD abc123', 'detached', ''].join('\n');

  const [worktree] = parseWorktreeList(output);
  expect(worktree.detached).toBe(true);
  expect(worktree.branch).toBeUndefined();
});

it('marks a bare repository record', () => {
  const output = ['worktree /repo.git', 'bare', ''].join('\n');

  const [worktree] = parseWorktreeList(output);
  expect(worktree.bare).toBe(true);
  expect(worktree.head).toBeUndefined();
});

it('marks locked and prunable worktrees, including the reason-carrying forms', () => {
  const output = [
    'worktree /repo/.worktrees/locked',
    'HEAD abc123',
    'branch refs/heads/locked',
    'locked held for review',
    '',
    'worktree /repo/.worktrees/gone',
    'HEAD def456',
    'branch refs/heads/gone',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');

  const [locked, prunable] = parseWorktreeList(output);
  expect(locked.locked).toBe(true);
  expect(locked.prunable).toBe(false);
  expect(prunable.prunable).toBe(true);
});

it('keeps branch names that contain slashes intact', () => {
  const output = ['worktree /repo/.worktrees/fix', 'HEAD abc123', 'branch refs/heads/codex/fix-thing', ''].join('\n');

  expect(parseWorktreeList(output)[0].branch).toBe('codex/fix-thing');
});

it('returns an empty list for empty output', () => {
  expect(parseWorktreeList('')).toEqual([]);
});

it('parses a trailing record that is not terminated by a blank line', () => {
  const output = ['worktree /repo', 'HEAD abc123', 'branch refs/heads/main'].join('\n');

  expect(parseWorktreeList(output)).toHaveLength(1);
});
