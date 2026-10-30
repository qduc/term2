import fs from 'fs';
import path from 'path';
import { getConversationsDirForTest } from './conversation-persistence.js';
import { resolveSessionId } from '../session/session-identity.js';
/**
 * Session-scoped atomic storage for foreground queue ownership. The queue is
 * deliberately a sidecar to the append-only conversation journal: replacing
 * it never risks truncating conversation history.
 */
export function createSessionQueuePersistence(sessionId) {
    const pathForIdentity = () => path.join(getConversationsDirForTest(), `${resolveSessionId(sessionId)}.queue.json`);
    let filePath = pathForIdentity();
    return {
        load() {
            if (!fs.existsSync(filePath))
                return null;
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        },
        replace(record) {
            const successorPath = pathForIdentity();
            if (successorPath !== filePath) {
                // Move ownership rather than copy: restarting the predecessor must not
                // replay the successor's pending input. Rename before replacement keeps
                // the previous complete record recoverable if the next write fails.
                if (fs.existsSync(successorPath))
                    throw new Error('Successor queue sidecar already exists.');
                if (fs.existsSync(filePath))
                    fs.renameSync(filePath, successorPath);
                filePath = successorPath;
            }
            const directory = path.dirname(filePath);
            fs.mkdirSync(directory, { recursive: true });
            const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
            try {
                fs.writeFileSync(temporaryPath, JSON.stringify(record), 'utf8');
                fs.renameSync(temporaryPath, filePath);
            }
            finally {
                if (fs.existsSync(temporaryPath))
                    fs.unlinkSync(temporaryPath);
            }
        },
        quarantine() {
            if (!fs.existsSync(filePath))
                return;
            fs.renameSync(filePath, `${filePath}.invalid-${Date.now()}`);
        },
    };
}
//# sourceMappingURL=queue-persistence.js.map