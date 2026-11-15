import fs from 'node:fs';
import path from 'node:path';

function readPointer(filePath: string): string | undefined {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.size > 4096) return undefined;
    const bytes = Buffer.alloc(4097);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, null);
    if (count > 4096) return undefined;
    const value = bytes.toString('utf8', 0, count).replace(/\r?\n$/, '');
    return value && !/[\r\n\0]/.test(value) ? value : undefined;
  } finally {
    fs.closeSync(descriptor);
  }
}

function isCanonicalDirectory(directory: string): boolean {
  return fs.existsSync(directory) && fs.realpathSync(directory) === directory && fs.statSync(directory).isDirectory();
}

export function findGitCheckoutRoot(start: string): string | undefined {
  let dir = start;
  while (true) {
    if (fs.lstatSync(path.join(dir, '.git'), { throwIfNoEntry: false })) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Resolve paths for a Git-registered checkout with metadata outside its root. */
export function resolveGitWorktreeWritePaths(workspaceRoot: string): {
  read: string[];
  allow: string[];
  deny: string[];
  commonDir?: string;
} {
  const empty = { read: [], allow: [], deny: [] };
  try {
    const checkout = findGitCheckoutRoot(workspaceRoot);
    if (!checkout) return empty;
    const marker = path.join(checkout, '.git');
    const pointer = readPointer(marker);
    if (!pointer?.startsWith('gitdir: ')) return empty;
    const worktreeDir = path.resolve(checkout, pointer.slice('gitdir: '.length));
    const commonDir = path.dirname(path.dirname(worktreeDir));
    if (
      path.basename(path.dirname(worktreeDir)) !== 'worktrees' ||
      !isCanonicalDirectory(path.join(commonDir, 'objects')) ||
      /[*?{}\[\]]/.test(worktreeDir) ||
      !isCanonicalDirectory(worktreeDir) ||
      readPointer(path.join(worktreeDir, 'commondir')) !== '../..'
    )
      return empty;

    const backlink = readPointer(path.join(worktreeDir, 'gitdir'));
    if (!backlink || path.resolve(worktreeDir, backlink) !== marker) return empty;

    // Seatbelt can allow individual files even when Git has yet to create them.
    // The Linux backend uses bind mounts and needs a directory for atomic replacement.
    const sharedFiles =
      process.platform === 'darwin'
        ? ['packed-refs', 'packed-refs.lock', 'shallow', 'shallow.lock']
            .map((name) => path.join(commonDir, name))
            .filter((file) => fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() !== true)
        : [];

    const sharedDirectories = ['objects', 'refs', 'logs', 'reftable']
      .map((name) => path.join(commonDir, name))
      .filter(isCanonicalDirectory);
    const sharedReadFiles = ['config', 'HEAD', 'packed-refs', 'shallow']
      .map((name) => path.join(commonDir, name))
      .filter((file) => fs.lstatSync(file, { throwIfNoEntry: false })?.isFile());
    return {
      commonDir,
      read: [worktreeDir, ...sharedDirectories, ...sharedReadFiles],
      allow: [worktreeDir, ...sharedFiles, ...sharedDirectories],
      deny: ['commondir', 'gitdir', 'config.worktree'].map((name) => path.join(worktreeDir, name)),
    };
  } catch {
    return empty;
  }
}
