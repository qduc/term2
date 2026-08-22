import fs from 'node:fs';
import path from 'node:path';
import { GatewayPersistenceError, type GatewaySessionRecord } from './contracts.js';
import { GatewaySessionIndex } from './session-index.js';
import { fsyncDirectory, type GatewayStorageLayout } from './storage.js';

export type RetentionPolicy = {
  readonly closedRetentionMs: number;
  readonly maxSessionBytes: number;
  readonly maxGlobalBytes: number;
};

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  closedRetentionMs: 30 * 24 * 60 * 60 * 1000,
  maxSessionBytes: 128 * 1024 * 1024,
  maxGlobalBytes: 2 * 1024 * 1024 * 1024,
});

function directorySize(directory: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const pathname = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directorySize(pathname);
    else total += fs.statSync(pathname).size;
  }
  return total;
}

function acquireSessionLock(directory: string): string {
  const lockPath = path.join(directory, 'term2.lock');
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, purpose: 'retention' }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return lockPath;
  } catch (error) {
    throw new GatewayPersistenceError(
      'storage_capacity',
      error instanceof Error ? `session lock unavailable: ${error.message}` : 'session lock unavailable',
    );
  }
}

export class GatewayRetentionManager {
  readonly #index: GatewaySessionIndex;
  readonly #layout: GatewayStorageLayout;
  readonly #policy: RetentionPolicy;

  constructor(index: GatewaySessionIndex, layout: GatewayStorageLayout, policy: Partial<RetentionPolicy> = {}) {
    this.#index = index;
    this.#layout = layout;
    this.#policy = Object.freeze({ ...DEFAULT_RETENTION_POLICY, ...policy });
    if (Object.values(this.#policy).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw new GatewayPersistenceError('storage_capacity', 'retention policy must be finite and positive');
    }
  }

  sessionBytes(record: GatewaySessionRecord): number {
    const directory = this.#layout.existingSessionPath(record.ownerUserId, record.workspaceId, record.id);
    return directory ? directorySize(directory) : 0;
  }

  evictEligible(now = Date.now(), limit = 100): string[] {
    const evicted: string[] = [];
    // retentionEligibleAt is written as close-time + the single policy window;
    // the query receives the actual current time and does not apply it again.
    for (const record of this.#index.listEvictionCandidates(new Date(now).toISOString(), limit)) {
      if (record.status !== 'closed') continue;
      const directory = this.#layout.existingSessionPath(record.ownerUserId, record.workspaceId, record.id);
      if (!directory) continue;
      this.#index.tombstone(record.id);
      let lockPath: string | undefined;
      try {
        lockPath = acquireSessionLock(directory);
        fs.rmSync(directory, { recursive: true, force: false });
        // The removed entry lives below the workspace hash directory.
        fsyncDirectory(path.dirname(directory));
        this.#index.removeTombstoned(record.id);
        evicted.push(record.id);
      } catch (error) {
        throw error instanceof GatewayPersistenceError
          ? error
          : new GatewayPersistenceError('storage_capacity', 'session deletion failed');
      } finally {
        if (lockPath) {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // The directory may have been removed with the lock inside it.
          }
        }
      }
    }
    return evicted;
  }
}
