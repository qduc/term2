/** Exclusive writable authority for a logical Session. A per-root SQLite write
 * transaction provides cross-platform process-death recovery. The database is
 * permanent: unlinking it while live would split authorities.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { DIRECT_LOCK_DIRECTORY } from './direct-rolling-log.js';

export function acquireDirectWriterLock(path: string): () => void {
  // Resolve directory aliases before deriving the shared lock namespace.
  const directory = realpathSync(dirname(path));
  const lockDirectory = join(directory, DIRECT_LOCK_DIRECTORY);
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  if (!lstatSync(lockDirectory).isDirectory()) throw new Error('direct Session lock path is not a directory');
  let database: Database.Database | undefined;
  try {
    database = new Database(join(lockDirectory, `${basename(path)}.sqlite`), { timeout: 0 });
    database.exec('BEGIN IMMEDIATE');
  } catch (error) {
    database?.close();
    if ((error as { code?: string }).code === 'SQLITE_BUSY')
      throw new Error(`cannot acquire direct Session writer lock for ${path}: already in use`, { cause: error });
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    database!.close();
    released = true;
  };
}

/**
 * Whether another connection holds the writer lock of a logical Session now. It takes the lock for an instant and
 * gives it back, so a writer opening at that very moment can be refused; a reader that needs this (the session
 * browser's "previous") calls it rarely.
 */
export function directWriterLockHeld(directory: string, logicalSessionId: string): boolean {
  const file = join(directory, DIRECT_LOCK_DIRECTORY, `${logicalSessionId}.jsonl.sqlite`);
  if (!existsSync(file)) return false;
  let database: Database.Database | undefined;
  try {
    database = new Database(file, { timeout: 0, fileMustExist: true });
    database.exec('BEGIN IMMEDIATE');
    database.exec('ROLLBACK');
    return false;
  } catch (error) {
    return (error as { code?: string }).code === 'SQLITE_BUSY';
  } finally {
    database?.close();
  }
}
