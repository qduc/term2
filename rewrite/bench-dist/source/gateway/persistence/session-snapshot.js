import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const SNAPSHOT_FILENAME = 'session-snapshot.json';
const sessionSnapshotPath = (sessionDirectory) => path.join(sessionDirectory, SNAPSHOT_FILENAME);
export const readSessionSnapshot = async (sessionDirectory) => {
    let raw;
    try {
        raw = await fs.readFile(sessionSnapshotPath(sessionDirectory), 'utf8');
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return { state: 'absent' };
        return { state: 'corrupt' };
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object')
            return { state: 'corrupt' };
        const record = parsed;
        if (record.schemaVersion !== 1 ||
            typeof record.providerId !== 'string' ||
            record.providerId.length === 0 ||
            typeof record.modelId !== 'string' ||
            record.modelId.length === 0 ||
            typeof record.reasoningEffort !== 'string') {
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
    }
    catch {
        return { state: 'corrupt' };
    }
};
/** Best-effort atomic write; callers decide whether failure is tolerable. */
export const writeSessionSnapshot = async (sessionDirectory, snapshot) => {
    const target = sessionSnapshotPath(sessionDirectory);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, target);
};
//# sourceMappingURL=session-snapshot.js.map