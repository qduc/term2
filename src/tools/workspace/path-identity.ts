import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The one spelling rule for paths that approvals show, grant and match.
 *
 * Only `~` and `~/` (or `~\`) name the current user's home. `~user` is left
 * literal: expanding it to this user's home would grant or display the wrong
 * folder.
 */
export function expandHome(raw: string, home: string = os.homedir()): string {
  if (raw === '~') return home;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(home, raw.slice(2));
  return raw;
}

/** Absolute, normalised, home-expanded; no filesystem access. */
export function lexicalPath(raw: string, baseDir: string): string {
  return path.resolve(baseDir, expandHome(raw));
}

/**
 * The path a grant is stored and matched under.
 *
 * Local paths resolve symlinks through the longest existing ancestor and keep
 * the missing tail, so a file that does not exist yet still has a stable
 * identity. A dangling symlink or an unreadable ancestor falls back to the
 * lexical path. Remote (SSH) paths are never resolved against this host's
 * filesystem and stay lexical.
 */
export function canonicalPath(raw: string, baseDir: string, options: { remote?: boolean } = {}): string {
  const lexical = lexicalPath(raw, baseDir);
  if (options.remote) return lexical;
  const missing: string[] = [];
  let candidate = lexical;
  while (true) {
    try {
      return path.join(fs.realpathSync(candidate), ...missing.reverse());
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return lexical;
      if (fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) return lexical;
      const parent = path.dirname(candidate);
      if (parent === candidate) return lexical;
      missing.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

/** `target` equals `folder` or lies beneath it. Both must already be in the same form. */
export function isPathWithin(target: string, folder: string): boolean {
  if (target === folder) return true;
  const prefix = folder.endsWith(path.sep) ? folder : `${folder}${path.sep}`;
  return target.startsWith(prefix);
}
