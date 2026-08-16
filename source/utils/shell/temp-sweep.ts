import { promises as fs } from 'fs';
import path from 'path';
import { SANDBOX_TEMP_DIR } from './temp-dir.js';

export interface ParsedTempArtifactMeta {
  prefix: string;
  pid: number;
  timestamp: number;
  suffix: string;
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_DEAD_PID_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check whether a process with the given PID is currently alive on the system.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but we lack permission to signal it (still alive).
    // ESRCH means no such process exists (dead).
    return error?.code === 'EPERM';
  }
}

/**
 * Parse metadata from filename pattern: `<prefix>-<pid>-<timestamp>-<suffix>.<ext>`
 */
export function parseTempArtifactMeta(filename: string): ParsedTempArtifactMeta | null {
  const match = /^([a-zA-Z0-9_-]+?)-(\d+)-(\d+)-([a-fA-F0-9]+)\.[a-zA-Z0-9]+$/.exec(filename);
  if (!match) return null;
  const pid = parseInt(match[2]!, 10);
  const timestamp = parseInt(match[3]!, 10);
  if (!Number.isFinite(pid) || !Number.isFinite(timestamp)) return null;
  return {
    prefix: match[1]!,
    pid,
    timestamp,
    suffix: match[4]!,
  };
}

export interface TempSweepOptions {
  baseTempDir?: string;
  systemTmpDir?: string;
  maxAgeMs?: number;
  deadPidGracePeriodMs?: number;
  now?: number;
  checkPidAlive?: (pid: number) => boolean;
}

/**
 * Sweep and prune dead-PID and stale temporary artifacts across term2 temp directories.
 * Safe to run non-blockingly at startup.
 */
export async function pruneStaleTempArtifacts(options: TempSweepOptions = {}): Promise<void> {
  const baseTempDir = options.baseTempDir ?? SANDBOX_TEMP_DIR;
  const systemTmpDir = options.systemTmpDir;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const deadPidGracePeriodMs = options.deadPidGracePeriodMs ?? DEFAULT_DEAD_PID_GRACE_PERIOD_MS;
  const now = options.now ?? Date.now();
  const checkPid = options.checkPidAlive ?? isPidAlive;

  // 1. Sweep individual artifact directories under SANDBOX_TEMP_DIR
  const artifactSubdirs = ['tool-output', 'subagent-result'];
  for (const subdir of artifactSubdirs) {
    const dirPath = path.join(baseTempDir, subdir);
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.join(dirPath, entry.name);
        try {
          const meta = parseTempArtifactMeta(entry.name);
          let shouldPrune = false;

          if (meta) {
            const isDead = !checkPid(meta.pid);
            const ageFromTimestamp = now - meta.timestamp;
            if (isDead && ageFromTimestamp > deadPidGracePeriodMs) {
              shouldPrune = true;
            } else if (ageFromTimestamp > maxAgeMs) {
              shouldPrune = true;
            }
          } else {
            // Unparseable filename: fall back to mtime
            const stat = await fs.stat(filePath);
            if (now - stat.mtimeMs > maxAgeMs) {
              shouldPrune = true;
            }
          }

          if (shouldPrune) {
            await fs.unlink(filePath).catch(() => {});
          }
        } catch {
          // File may have been removed concurrently or inaccessible; skip
        }
      }
    } catch {
      // Subdirectory may not exist yet; skip
    }
  }

  // 2. Sweep docker-config-* directories under SANDBOX_TEMP_DIR
  try {
    const baseEntries = await fs.readdir(baseTempDir, { withFileTypes: true });
    for (const entry of baseEntries) {
      if (entry.isDirectory() && entry.name.startsWith('docker-config-')) {
        const dirPath = path.join(baseTempDir, entry.name);
        try {
          const stat = await fs.stat(dirPath);
          if (now - stat.mtimeMs > maxAgeMs) {
            await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {});
          }
        } catch {
          // Skip
        }
      }
    }
  } catch {
    // Skip
  }

  // 3. Sweep legacy orphaned directories in system tmpdir if specified
  if (systemTmpDir) {
    try {
      const tmpEntries = await fs.readdir(systemTmpDir, { withFileTypes: true });
      for (const entry of tmpEntries) {
        if (
          entry.isDirectory() &&
          (entry.name.startsWith('term2-tool-output-') || entry.name.startsWith('term2-subagent-result-'))
        ) {
          const dirPath = path.join(systemTmpDir, entry.name);
          try {
            const stat = await fs.stat(dirPath);
            if (now - stat.mtimeMs > maxAgeMs) {
              await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {});
            }
          } catch {
            // Skip
          }
        }
      }
    } catch {
      // Skip
    }
  }
}
