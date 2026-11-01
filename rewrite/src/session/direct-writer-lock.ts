/** Exclusive writable authority for a logical Session, held on its root log inode.
 * All writers must acquire this before replay and hold it until the log is closed.
 * The OS releases it on process death; no stale lockfile or timeout is involved.
 */
import { closeSync, openSync } from 'node:fs';
import koffi from 'koffi';

export function acquireDirectWriterLock(path: string): () => void {
  if (process.platform !== 'linux' && process.platform !== 'darwin')
    throw new Error(`direct Session writer locking is unsupported on ${process.platform}`);
  const fd = openSync(path, 'r');
  try {
    const flock = koffi.load(null).func('int flock(int fd, int operation)');
    if (flock(fd, 2 | 4) !== 0) {
      const errno = koffi.errno();
      throw new Error(`cannot acquire direct Session writer lock for ${path} (errno ${errno})`);
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    closeSync(fd);
    released = true;
  };
}
