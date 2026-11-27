/** Canonical native conversations store path helpers (zero native addons; safe for CLI fast path). */
import fs from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import envPaths from 'env-paths';

/** Resolves aliases even when the store or a symlink's target does not exist yet. */
export function resolvedStorePath(filename: string): string {
  const supplied = path.isAbsolute(filename) ? filename : `${process.cwd()}${path.sep}${filename}`;
  const root = path.parse(supplied).root;
  const absolute = root + supplied.slice(root.length).replace(process.platform === 'win32' ? /[\\/]+$/ : /\/+$/, '');
  try {
    return fs.realpathSync.native(absolute);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    let link: string | undefined;
    try {
      link = fs.readlinkSync(absolute);
    } catch (linkError) {
      if (!(linkError instanceof Error && 'code' in linkError && ['ENOENT', 'EINVAL'].includes(String(linkError.code))))
        throw linkError;
    }
    if (link !== undefined) {
      return resolvedStorePath(path.isAbsolute(link) ? link : `${path.dirname(absolute)}${path.sep}${link}`);
    }
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(resolvedStorePath(parent), path.basename(absolute));
  }
}

/** Canonical conversations directory matching `cli.ts` (`TERM2_CONVERSATIONS_DIR` or `<xdg-data>/conversations-next`). */
export function resolveConversationsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const data = envPaths('term2').data;
  const directory = resolvedStorePath(env['TERM2_CONVERSATIONS_DIR'] ?? path.join(data, 'conversations-next'));
  const comparable = (filename: string) =>
    process.platform === 'darwin' || process.platform === 'win32' ? filename.toLowerCase() : filename;
  if (comparable(directory) === comparable(resolvedStorePath(path.join(data, 'conversations')))) {
    throw new Error('The legacy conversations directory is read-only; use a separate native conversations directory');
  }
  return directory;
}

/** Refuses any existing filename outside the `conv_` namespace. Enumerates names only. */
export async function checkConversationsDirectory(directory: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  const incompatible = entries.find((name) => !name.startsWith('conv_'));
  if (incompatible !== undefined) {
    throw new Error(`Refusing conversations directory containing a non-M1 entry: ${JSON.stringify(incompatible)}`);
  }
}
