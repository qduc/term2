import { getConversationsDir, listConversations } from './conversation-persistence.js';
import { SessionIndexWorkerClient } from './session-index/session-index-worker-client.js';
/**
 * The resume selector renders a fixed-size chooser; the terminal UI historically
 * rendered `listConversations(...).slice(0, 10)`, so an omitted limit preserves
 * that behavior.
 */
export const DEFAULT_RECENT_CONVERSATIONS_LIMIT = 10;
/**
 * Asynchronous counterpart of `listConversations` for the interactive resume
 * selector.
 *
 * The canonical listing replays every conversation log in the directory, which
 * is far too heavy to run on the UI thread. This runs that exact parse inside
 * the session-index worker thread (reusing its worker infrastructure rather
 * than introducing another index) so the returned entries — project/SSH scope,
 * update ordering, short refs, and metadata — are byte-for-byte what
 * `listConversations(projectPath, sshHost)` returns, just off the main thread.
 *
 * The index database is intentionally not consulted: its `list` projection
 * stores `updated_at` from the session state rather than file mtime, counts
 * projected records rather than user/assistant turns, and omits
 * `activeProfileId`/`appMode`/`sshHost`/`projectPath`, so it cannot reproduce
 * the resume selector's semantics.
 */
export async function listRecentConversations(projectPath, sshHost, limit = DEFAULT_RECENT_CONVERSATIONS_LIMIT, options) {
    const entries = await listConversationsOffMainThread(projectPath, sshHost, limit, options);
    if (!Number.isFinite(limit))
        return entries;
    return entries.slice(0, Math.max(0, Math.floor(limit)));
}
async function listConversationsOffMainThread(projectPath, sshHost, limit, options) {
    const createClient = options?.createClient ??
        (() => new SessionIndexWorkerClient(undefined, undefined, { timeoutMs: options?.workerTimeoutMs }));
    let client = null;
    let failed = false;
    try {
        client = createClient();
        return await client.listConversationsInDirectory(getConversationsDir(), projectPath, sshHost, limit);
    }
    catch (error) {
        failed = true;
        options?.onFallback?.(error instanceof Error ? error.message : String(error));
        // Last resort only: the worker thread itself is unusable (for example the
        // runtime forbids worker threads). Parsing in-process keeps the listing
        // correct at the cost of briefly blocking, which is preferable to returning
        // a misleadingly empty list.
        return listConversations(projectPath, sshHost, limit);
    }
    finally {
        await client?.close({ force: failed }).catch(() => { });
    }
}
//# sourceMappingURL=recent-conversations.js.map