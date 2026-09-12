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
 * Reading is three-valued on purpose: a session created before the sidecar
 * existed has *no* record (a documented compatibility state), while a record
 * that exists but cannot be trusted is corruption and must be refused, never
 * silently treated as legacy.
 */
export type SessionSnapshotRead =
  | { state: 'absent' }
  | { state: 'readable'; snapshot: PersistedSessionSnapshot }
  | { state: 'corrupt' };

export const readSessionSnapshot = async (sessionDirectory: string): Promise<SessionSnapshotRead> => {
  let raw: string;
  try {
    raw = await fs.readFile(sessionSnapshotPath(sessionDirectory), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { state: 'absent' };
    return { state: 'corrupt' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return { state: 'corrupt' };
    const record = parsed as Record<string, unknown>;
    if (
      record.schemaVersion !== 1 ||
      typeof record.providerId !== 'string' ||
      record.providerId.length === 0 ||
      typeof record.modelId !== 'string' ||
      record.modelId.length === 0 ||
      typeof record.reasoningEffort !== 'string'
    ) {
      return { state: 'corrupt' };
    }
    return {
      state: 'readable',
      snapshot: {
        schemaVersion: 1,
        providerId: record.providerId,
        modelId: record.modelId,
        reasoningEffort: record.reasoningEffort,
      },
    };
  } catch {
    return { state: 'corrupt' };
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
