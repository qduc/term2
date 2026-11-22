/**
 * The `settings.json.lock` sibling that serializes writers sharing one settings
 * directory. A fresh-mtime lock is waited on for the timeout budget; a stale-mtime
 * lock is reclaimed by policy (mtime proves nothing about the holder's liveness).
 * The token written into the lock lets only its own holder release it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;

export type LockOptions = {
  retryMs?: number;
  timeoutMs?: number;
  staleMs?: number;
};

function waitForLockRetry(retryMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, retryMs);
}

export function acquireSettingsLock(settingsDir: string, options: LockOptions = {}): () => void {
  const lockFile = path.join(settingsDir, 'settings.json.lock');
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const staleMs = options.staleMs ?? STALE_LOCK_MS;
  const deadline = Date.now() + (options.timeoutMs ?? LOCK_TIMEOUT_MS);

  while (true) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      const token = randomUUID();
      try {
        fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }), 'utf-8');
      } finally {
        fs.closeSync(fd);
      }

      return () => {
        try {
          const content = fs.readFileSync(lockFile, 'utf-8');
          const current: unknown = JSON.parse(content);
          if (!current || typeof current !== 'object' || (current as { token?: unknown }).token !== token) {
            return;
          }
          fs.unlinkSync(lockFile);
        } catch (error: unknown) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && !(error instanceof SyntaxError)) {
            throw error;
          }
        }
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }

      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (lockError: unknown) {
        if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw lockError;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for settings lock at ${lockFile}`);
      }
      waitForLockRetry(retryMs);
    }
  }
}
