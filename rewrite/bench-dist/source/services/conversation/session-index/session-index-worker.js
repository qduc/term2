import { parentPort } from 'node:worker_threads';
import { SessionIndexDatabase } from './session-index-database.js';
import { listConversationsInDirectory } from '../conversation-persistence.js';
import { SessionBrowser, } from '../session-browser.js';
export function runSessionIndexWorker() {
    if (!parentPort) {
        throw new Error('runSessionIndexWorker must be called in a worker thread with parentPort');
    }
    let db = null;
    let canonicalContext = { projectPath: '' };
    const canonicalBrowser = new SessionBrowser(() => canonicalContext, { backend: 'canonical', cursorPrefix: 'f' });
    parentPort.on('message', (msg) => {
        if (!msg || typeof msg !== 'object' || typeof msg.id !== 'number')
            return;
        try {
            switch (msg.type) {
                case 'canonical_browse': {
                    // A dedicated fallback client owns this worker. Its environment is
                    // isolated from the UI process; keep browser cursor state here too.
                    process.env['TERM2_CONVERSATIONS_DIR'] = msg.conversationsDir;
                    canonicalContext = msg.context;
                    const result = msg.operation === 'list'
                        ? canonicalBrowser.list(msg.input)
                        : msg.operation === 'search'
                            ? canonicalBrowser.search(msg.input)
                            : canonicalBrowser.read(msg.input);
                    parentPort.postMessage({ id: msg.id, ok: true, result });
                    break;
                }
                case 'init': {
                    if (db)
                        db.close();
                    db = new SessionIndexDatabase(msg.dbPath, msg.sourceDirectory);
                    parentPort.postMessage({ id: msg.id, ok: true, result: { initialized: true } });
                    break;
                }
                case 'probe': {
                    if (!db)
                        throw new Error('Database not initialized');
                    const result = db.probeCapability();
                    parentPort.postMessage({ id: msg.id, ok: true, result });
                    break;
                }
                case 'reconcile': {
                    if (!db)
                        throw new Error('Database not initialized');
                    const result = db.reconcile();
                    parentPort.postMessage({ id: msg.id, ok: true, result });
                    break;
                }
                case 'list': {
                    if (!db)
                        throw new Error('Database not initialized');
                    const result = db.list(msg.options);
                    parentPort.postMessage({ id: msg.id, ok: true, result });
                    break;
                }
                case 'list_conversations': {
                    // Canonical resume-listing parse. Deliberately independent of the
                    // index database so it still runs when the index is unavailable;
                    // the directory is threaded through rather than read from the
                    // worker's own environment.
                    const result = listConversationsInDirectory(msg.conversationsDir, msg.projectPath, msg.sshHost, msg.limit);
                    parentPort.postMessage({
                        id: msg.id,
                        ok: true,
                        result: Number.isFinite(msg.limit) ? result.slice(0, Math.max(0, Math.floor(msg.limit))) : result,
                    });
                    break;
                }
                case 'resolve': {
                    if (!db)
                        throw new Error('Database not initialized');
                    const result = db.resolveReference(msg.reference, msg.options);
                    parentPort.postMessage({ id: msg.id, ok: true, result });
                    break;
                }
                case 'get_revision': {
                    if (!db)
                        throw new Error('Database not initialized');
                    const result = db.getRevision(msg.sessionId);
                    parentPort.postMessage({ id: msg.id, ok: true, result });
                    break;
                }
                case 'read_session': {
                    if (!db)
                        throw new Error('Database not initialized');
                    const result = db.readSession(msg.sessionId, msg.options);
                    parentPort.postMessage({ id: msg.id, ok: true, result });
                    break;
                }
                case 'search': {
                    if (!db)
                        throw new Error('Database not initialized');
                    const result = db.search(msg.options);
                    parentPort.postMessage({ id: msg.id, ok: true, result });
                    break;
                }
                case 'close': {
                    if (db) {
                        db.close();
                        db = null;
                    }
                    parentPort.postMessage({ id: msg.id, ok: true, result: { closed: true } });
                    break;
                }
                default: {
                    const exhaustiveCheck = msg;
                    parentPort.postMessage({
                        id: exhaustiveCheck.id,
                        ok: false,
                        error: `Unknown worker request type: ${exhaustiveCheck.type}`,
                    });
                }
            }
        }
        catch (error) {
            parentPort.postMessage({
                id: msg.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
//# sourceMappingURL=session-index-worker.js.map