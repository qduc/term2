// Snapshots the working tree (tracked, untracked, uncommitted; not ignored) as
// a git tree object using a throwaway index, so the repo's own index and
// worktree are never touched.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 29, ...opts });
}

export function snapshotTree(cwd) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-impact-idx-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    git(['read-tree', 'HEAD'], { cwd, env });
    git(['add', '-A'], { cwd, env });
    return git(['write-tree'], { cwd, env }).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
