import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Hash every regular file under a fixture root, with relative-path keys. */
export async function inventory(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) throw new Error('Fixture inventory requires regular files');
    const file = path.join(entry.parentPath, entry.name);
    result[path.relative(directory, file)] = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  }
  return result;
}
