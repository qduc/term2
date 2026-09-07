import { spawnSync } from 'node:child_process';

export function gitRev(worktree) {
  const result = spawnSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('git rev-parse failed in ' + worktree + ': ' + result.stderr);
  return result.stdout.trim();
}

export function gitDirty(worktree) {
  const result = spawnSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8' });
  return result.stdout.trim().length > 0;
}

export function sourceTreeMatchesPin(worktree, pin) {
  const committed = spawnSync('git', ['-C', worktree, 'diff', '--quiet', pin, 'HEAD', '--', 'source/']);
  const unstaged = spawnSync('git', ['-C', worktree, 'diff', '--quiet', '--', 'source/']);
  const staged = spawnSync('git', ['-C', worktree, 'diff', '--quiet', '--cached', '--', 'source/']);
  return {
    matches: committed.status === 0 && unstaged.status === 0 && staged.status === 0,
    committedDiffers: committed.status !== 0,
    unstagedDiffers: unstaged.status !== 0,
    stagedDiffers: staged.status !== 0,
  };
}

export function fullSha(worktree, rev) {
  const result = spawnSync('git', ['-C', worktree, 'rev-parse', rev], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}
