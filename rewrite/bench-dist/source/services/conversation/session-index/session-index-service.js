import path from 'node:path';
import { getConversationsDir } from '../conversation-persistence.js';
import { SessionIndexWorkerClient } from './session-index-worker-client.js';
function resolveDefaultSessionIndexPath(conversationsDir) {
    if (process.env['TERM2_SESSION_INDEX_PATH']) {
        return process.env['TERM2_SESSION_INDEX_PATH'];
    }
    return path.join(path.dirname(conversationsDir), 'session-index.db');
}
export class SessionIndexService {
    #conversationsDir;
    #dbPath;
    #backend;
    #workerTimeoutMs;
    #logger;
    #workerClient = null;
    #directDb = null;
    #probeAttempted = false;
    #available = false;
    #fallbackReason = null;
    constructor(options) {
        this.#conversationsDir = options?.conversationsDir ?? getConversationsDir();
        this.#dbPath = options?.dbPath ?? resolveDefaultSessionIndexPath(this.#conversationsDir);
        this.#backend = options?.backend ?? 'worker';
        this.#workerTimeoutMs = options?.workerTimeoutMs;
        this.#logger = options?.logger;
        if (options?.workerClient) {
            this.#workerClient = options.workerClient;
        }
    }
    isAvailable() {
        return this.#available;
    }
    getFallbackReason() {
        return this.#fallbackReason;
    }
    async ensureReady() {
        if (this.#probeAttempted) {
            return this.#available;
        }
        this.#probeAttempted = true;
        try {
            if (this.#backend === 'direct') {
                const { SessionIndexDatabase } = await import('./session-index-database.js');
                this.#directDb = new SessionIndexDatabase(this.#dbPath, this.#conversationsDir);
                const probe = this.#directDb.probeCapability();
                if (!probe.ok) {
                    this.#available = false;
                    this.#fallbackReason = probe.reason;
                    this.#logger?.warn('Session query index capability probe failed, falling back to canonical browser', {
                        reason: probe.reason,
                    });
                    return false;
                }
                this.#available = true;
                return true;
            }
            // Worker backend
            if (!this.#workerClient) {
                this.#workerClient = new SessionIndexWorkerClient(this.#dbPath, this.#conversationsDir, {
                    timeoutMs: this.#workerTimeoutMs,
                });
            }
            const probe = await this.#workerClient.probe();
            if (!probe.ok) {
                this.#available = false;
                this.#fallbackReason = probe.reason;
                this.#logger?.warn('Session query index capability probe failed, falling back to canonical browser', {
                    reason: probe.reason,
                });
                return false;
            }
            this.#available = true;
            return true;
        }
        catch (error) {
            this.#available = false;
            this.#fallbackReason = error instanceof Error ? error.message : String(error);
            this.#logger?.warn('Session query index initialization failed, falling back to canonical browser', {
                error: this.#fallbackReason,
            });
            return false;
        }
    }
    async reconcile() {
        const ready = await this.ensureReady();
        if (!ready) {
            return {
                ok: false,
                replayedCount: 0,
                deletedCount: 0,
                stable: false,
                error: this.#fallbackReason ?? 'Unavailable',
            };
        }
        try {
            if (this.#backend === 'direct' && this.#directDb) {
                return this.#directDb.reconcile();
            }
            return await this.#workerClient.reconcile();
        }
        catch (error) {
            this.#logger?.warn('Session query index reconciliation failed', {
                error: error instanceof Error ? error.message : String(error),
            });
            return {
                ok: false,
                replayedCount: 0,
                deletedCount: 0,
                stable: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    async list(context) {
        const ready = await this.ensureReady();
        if (!ready)
            return null;
        const reconcileResult = await this.reconcile();
        if (!reconcileResult.ok || !reconcileResult.stable) {
            return null; // Fall back to canonical on mid-replay change or error
        }
        try {
            if (this.#backend === 'direct' && this.#directDb) {
                return this.#directDb.list({ projectPath: context.projectPath, sshHost: context.sshHost });
            }
            return await this.#workerClient.list({ projectPath: context.projectPath, sshHost: context.sshHost });
        }
        catch {
            return null;
        }
    }
    async resolveReference(reference, context) {
        const ready = await this.ensureReady();
        if (!ready)
            return null;
        const reconcileResult = await this.reconcile();
        if (!reconcileResult.ok || !reconcileResult.stable) {
            return null; // Fall back to canonical
        }
        try {
            if (this.#backend === 'direct' && this.#directDb) {
                return this.#directDb.resolveReference(reference, {
                    projectPath: context.projectPath,
                    sshHost: context.sshHost,
                    currentSessionId: context.currentSessionId,
                });
            }
            return await this.#workerClient.resolveReference(reference, {
                projectPath: context.projectPath,
                sshHost: context.sshHost,
                currentSessionId: context.currentSessionId,
            });
        }
        catch {
            return null;
        }
    }
    async getRevision(sessionId) {
        const ready = await this.ensureReady();
        if (!ready)
            return null;
        try {
            if (this.#backend === 'direct' && this.#directDb) {
                return this.#directDb.getRevision(sessionId);
            }
            return await this.#workerClient.getRevision(sessionId);
        }
        catch {
            return null;
        }
    }
    async readSession(sessionId, context) {
        const ready = await this.ensureReady();
        if (!ready)
            return null;
        const reconcileResult = await this.reconcile();
        if (!reconcileResult.ok || !reconcileResult.stable) {
            return null; // Fall back to canonical on mid-replay change or error
        }
        try {
            if (this.#backend === 'direct' && this.#directDb) {
                return this.#directDb.readSession(sessionId, {
                    projectPath: context.projectPath,
                    sshHost: context.sshHost,
                });
            }
            return await this.#workerClient.readSession(sessionId, {
                projectPath: context.projectPath,
                sshHost: context.sshHost,
            });
        }
        catch {
            return null;
        }
    }
    async search(query, context) {
        const ready = await this.ensureReady();
        if (!ready)
            return null;
        const reconcileResult = await this.reconcile();
        if (!reconcileResult.ok || !reconcileResult.stable) {
            return null; // Fall back to canonical on mid-replay change or error
        }
        try {
            if (this.#backend === 'direct' && this.#directDb) {
                return this.#directDb.search({
                    query,
                    projectPath: context.projectPath,
                    sshHost: context.sshHost,
                });
            }
            return await this.#workerClient.search({
                query,
                projectPath: context.projectPath,
                sshHost: context.sshHost,
            });
        }
        catch {
            return null;
        }
    }
    async close() {
        if (this.#directDb) {
            this.#directDb.close();
            this.#directDb = null;
        }
        if (this.#workerClient) {
            await this.#workerClient.close();
            this.#workerClient = null;
        }
    }
}
//# sourceMappingURL=session-index-service.js.map