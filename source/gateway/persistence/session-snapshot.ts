import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Durable per-session provider/model snapshot. A session's provider/model
 * identity is immutable: a restart must restore the session onto exactly the
 * configuration it was created with, never the launcher's current default.
 * Stored as a sidecar next to the session transcript because the gateway
 * session index schema is append-only from the operator's perspective.
 */
export type PersistedSessionSnapshot = {
  schemaVersion: 1;
  providerId: string;
  modelId: string;
  reasoningEffort: string;
};

const SNAPSHOT_FILENAME = 'session-snapshot.json';

export const sessionSnapshotPath = (sessionDirectory: string): string => path.join(sessionDirectory, SNAPSHOT_FILENAME);

/**
 * Returns the stored snapshot, or null when there is none. Absence is a
 * documented state, not an error: sessions created before the sidecar existed
 * fall back to the launcher's current snapshot (which is still validated
 * against the live registry/catalog before the runtime is created). A file
 * that exists but does not parse as the current schema is treated the same
 * way; the fallback keeps such a session recoverable.
 */
export const readSessionSnapshot = async (sessionDirectory: string): Promise<PersistedSessionSnapshot | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(sessionSnapshotPath(sessionDirectory), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (
      record.schemaVersion !== 1 ||
      typeof record.providerId !== 'string' ||
      record.providerId.length === 0 ||
      typeof record.modelId !== 'string' ||
      record.modelId.length === 0 ||
      typeof record.reasoningEffort !== 'string'
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      providerId: record.providerId,
      modelId: record.modelId,
      reasoningEffort: record.reasoningEffort,
    };
  } catch {
    return null;
  }
};

/** Best-effort atomic write; callers decide whether failure is tolerable. */
export const writeSessionSnapshot = async (
  sessionDirectory: string,
  snapshot: PersistedSessionSnapshot,
): Promise<void> => {
  const target = sessionSnapshotPath(sessionDirectory);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, target);
};
