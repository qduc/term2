/** Exclusive writable authority for a logical Session. A per-root SQLite write
 * transaction provides cross-platform process-death recovery; on Unix we also
 * hold the root inode flock for compatibility with the earlier native writer.
 * The lock database is permanent: unlinking it would split live authorities.
 */
import { closeSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import koffi from 'koffi';

export function acquireDirectWriterLock(path: string): () => void {
  // Resolve directory aliases before deriving the shared lock namespace. It is
  // outside conversations-next, whose entries must remain only native logs.
  const directory = realpathSync(dirname(path));
  const lockDirectory = `${directory}.locks`;
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  let fd: number | undefined;
  let database: Database.Database | undefined;
  try {
    if (process.platform === 'linux' || process.platform === 'darwin') {
      fd = openSync(path, 'r');
      const flock = koffi.load(null).func('int flock(int fd, int operation)');
      if (flock(fd, 2 | 4) !== 0)
        throw new Error(`cannot acquire direct Session writer lock for ${path} (errno ${koffi.errno()})`);
    }
    database = new Database(join(lockDirectory, `${basename(path)}.sqlite`), { timeout: 0 });
    database.exec('BEGIN IMMEDIATE');
  } catch (error) {
    // Close the transaction before dropping the older-protocol Unix lock.
    database?.close();
    if (fd !== undefined) closeSync(fd);
    if ((error as { code?: string }).code === 'SQLITE_BUSY')
      throw new Error(`cannot acquire direct Session writer lock for ${path}: already in use`, { cause: error });
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    database!.close();
    if (fd !== undefined) closeSync(fd);
    released = true;
  };
}
