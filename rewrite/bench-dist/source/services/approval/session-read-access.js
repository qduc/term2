import path from 'node:path';
import { getActiveWorkspaceRoot } from '../workspace/active-workspace-root.js';
/** Session-scoped allowlist for read-only access outside the workspace. */
export class SessionReadAccess {
    #foldersBySession = new Map();
    allowFolder(sessionId, folder) {
        const folders = this.#foldersBySession.get(sessionId) ?? new Set();
        folders.add(folder);
        this.#foldersBySession.set(sessionId, folders);
    }
    allows(sessionId, targetPath, baseDir = getActiveWorkspaceRoot()) {
        const folders = this.#foldersBySession.get(sessionId);
        if (!folders)
            return false;
        const target = path.resolve(baseDir, targetPath);
        return [...folders].some((folder) => {
            const resolvedFolder = path.resolve(baseDir, folder);
            return target === resolvedFolder || target.startsWith(`${resolvedFolder}${path.sep}`);
        });
    }
    clear(sessionId) {
        this.#foldersBySession.delete(sessionId);
    }
}
export const sessionReadAccess = new SessionReadAccess();
/**
 * Shared read-approval bypass for the read-only file tools. Root clients own a
 * SessionAccessState; nested tools fall back to the session-keyed legacy state.
 */
export function isSessionReadGranted(resolvedPath, cwd, context, deps) {
    const { sessionAccess, nestedCompatibility } = deps;
    if (sessionAccess) {
        return sessionAccess.allowsRead(resolvedPath, cwd);
    }
    const sessionId = getSessionIdFromToolContext(context);
    return !!sessionId && !!nestedCompatibility?.allowsRead(sessionId, resolvedPath, cwd);
}
function getSessionIdFromToolContext(context) {
    if (!context || typeof context !== 'object')
        return null;
    const runContext = context;
    if (!runContext.context || typeof runContext.context !== 'object')
        return null;
    const sessionId = runContext.context.sessionId;
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}
//# sourceMappingURL=session-read-access.js.map