import fs from 'fs';
import path from 'path';
import { type PersistedQueueV1, type QueuePersistence } from '../queue/queue-controller.js';
import { getConversationsDirForTest } from './conversation-persistence.js';

/**
 * Session-scoped atomic storage for foreground queue ownership. The queue is
 * deliberately a sidecar to the append-only conversation journal: replacing
 * it never risks truncating conversation history.
 */
export function createSessionQueuePersistence<Snapshot>(sessionId: string): QueuePersistence<Snapshot> {
  const filePath = path.join(getConversationsDirForTest(), `${sessionId}.queue.json`);

  return {
    load(): unknown {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    },
    replace(record: PersistedQueueV1<Snapshot>): void {
      const directory = path.dirname(filePath);
      fs.mkdirSync(directory, { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporaryPath, JSON.stringify(record), 'utf8');
        fs.renameSync(temporaryPath, filePath);
      } finally {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      }
    },
    quarantine(): void {
      if (!fs.existsSync(filePath)) return;
      fs.renameSync(filePath, `${filePath}.invalid-${Date.now()}`);
    },
  };
}
