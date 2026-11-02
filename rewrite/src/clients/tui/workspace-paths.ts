import { promises as fs } from 'node:fs';
import path from 'node:path';
import { default as createIgnore, type Ignore } from 'ignore';

export type WorkspacePath = { readonly path: string; readonly type: 'file' | 'directory' };

const LIMIT = 5000;
const ALWAYS_SKIPPED = new Set(['.git', 'node_modules']);

/**
 * Files and directories under `root` for `@` completion: breadth-first so shallow paths come first, the root's
 * `.gitignore` honoured, `.git` and `node_modules` skipped, at most 5000 entries. A directory that cannot be read
 * is skipped, not fatal.
 */
export async function listWorkspacePaths(root: string): Promise<{ entries: WorkspacePath[]; truncated: boolean }> {
  const ignore = (createIgnore as unknown as () => Ignore)();
  try {
    ignore.add(await fs.readFile(path.join(root, '.gitignore'), 'utf8'));
  } catch {
    // No .gitignore: nothing extra to skip.
  }
  const entries: WorkspacePath[] = [];
  const queue: string[] = [''];
  while (queue.length) {
    const directory = queue.shift()!;
    let children;
    try {
      children = await fs.readdir(path.join(root, directory), { withFileTypes: true });
    } catch {
      continue;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (ALWAYS_SKIPPED.has(child.name)) continue;
      const relative = directory ? `${directory}/${child.name}` : child.name;
      const isDirectory = child.isDirectory();
      if (ignore.ignores(isDirectory ? `${relative}/` : relative)) continue;
      if (!isDirectory && !child.isFile()) continue;
      if (entries.length >= LIMIT) return { entries, truncated: true };
      entries.push({ path: relative, type: isDirectory ? 'directory' : 'file' });
      if (isDirectory) queue.push(relative);
    }
  }
  return { entries, truncated: false };
}
