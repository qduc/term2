import path from 'node:path';
import { promises as fs } from 'node:fs';
import { default as createIgnore } from 'ignore';
import { getActiveWorkspaceRoot } from './workspace/active-workspace-root.js';
/** Follows an `enter_worktree` lease; see active-workspace-root.ts. */
const workspaceRoot = () => getActiveWorkspaceRoot();
const DEFAULT_IGNORES = ['.git/**'];
const GITIGNORE_NAME = '.gitignore';
const MAX_SCAN_DEPTH = 25;
const WORKSPACE_PATH_COMPLETION_ENTRY_LIMIT = 10_000;
let cachedEntries = null;
let cachedRoot = null;
let lastLoadedAt = null;
let lastLoadTruncated = false;
let lastLoadTruncatedByTotalLimit = false;
const normalizePath = (entryPath) => entryPath.replaceAll(path.sep, '/');
// Resolve the target type of a symlink without traversing it. Symlinks are
// listed in completion results (matching the previous fast-glob behavior) but
// never descended into, to avoid traversal cycles.
const resolveSymlinkType = async (absolutePath) => {
    try {
        const stats = await fs.stat(absolutePath);
        return stats.isDirectory() ? 'directory' : 'file';
    }
    catch {
        // Broken symlink (dangling target): treat as a file so it remains listable.
        return 'file';
    }
};
const createIgnoreMatcher = async (cwd) => {
    const matcher = createIgnore();
    matcher.add(DEFAULT_IGNORES);
    const gitignorePath = path.join(cwd, GITIGNORE_NAME);
    try {
        const gitignoreContents = await fs.readFile(gitignorePath, 'utf8');
        matcher.add(gitignoreContents);
    }
    catch (error) {
        if (error.code !== 'ENOENT') {
            // Avoid importing the deprecated loggingService singleton here.
            // This is a non-critical warning; console output is sufficient.
            console.warn('[file-service] Failed to read .gitignore', {
                error: error instanceof Error ? error.message : String(error),
                path: gitignorePath,
            });
        }
    }
    return matcher;
};
const sortDirEntries = (entries) => entries.slice().sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory())
        return -1;
    if (!a.isDirectory() && b.isDirectory())
        return 1;
    return a.name.localeCompare(b.name);
});
const loadDirectoryEntries = async (cwd, options = {}) => {
    const matcher = await createIgnoreMatcher(cwd);
    const maxDepth = options.maxDepth ?? MAX_SCAN_DEPTH;
    const maxTotalEntries = options.maxTotalEntries ?? WORKSPACE_PATH_COMPLETION_ENTRY_LIMIT;
    const includeFiles = options.includeFiles ?? true;
    const queue = [{ dir: cwd, relativePath: '', depth: 0 }];
    const entries = [];
    let truncatedByTotalLimit = false;
    // Children are only enqueued while current.depth < maxDepth, so a queued node
    // can never exceed maxDepth; the only reason to stop draining the queue is the
    // total-entry cap.
    for (let index = 0; index < queue.length; index++) {
        const current = queue[index];
        if (entries.length >= maxTotalEntries) {
            truncatedByTotalLimit = true;
            continue;
        }
        let dirEntries;
        try {
            dirEntries = await fs.readdir(current.dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        const filtered = sortDirEntries(dirEntries).filter((entry) => {
            if (entry.name.length === 0)
                return false;
            if (!includeFiles && !entry.isDirectory())
                return false;
            const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
            const ignoredPath = entry.isDirectory() ? `${relativePath}/` : relativePath;
            return !matcher.ignores(ignoredPath);
        });
        for (let entryIndex = 0; entryIndex < filtered.length; entryIndex++) {
            if (entries.length >= maxTotalEntries) {
                truncatedByTotalLimit = true;
                break;
            }
            const entry = filtered[entryIndex];
            const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
            const normalizedPath = normalizePath(relativePath);
            const absolutePath = path.join(current.dir, entry.name);
            const type = entry.isSymbolicLink()
                ? await resolveSymlinkType(absolutePath)
                : entry.isDirectory()
                    ? 'directory'
                    : 'file';
            entries.push({ path: normalizedPath, type });
            // Only descend into real directories (entry.isDirectory() is false for
            // symlinks), so symlinked directories are listed but never traversed.
            if (entry.isDirectory() && current.depth < maxDepth) {
                queue.push({
                    dir: absolutePath,
                    relativePath: normalizedPath,
                    depth: current.depth + 1,
                });
            }
        }
    }
    return {
        entries,
        truncated: truncatedByTotalLimit,
        truncatedByTotalLimit,
    };
};
const loadWorkspaceEntries = async () => {
    const result = await loadDirectoryEntries(workspaceRoot());
    lastLoadTruncated = result.truncated;
    lastLoadTruncatedByTotalLimit = result.truncatedByTotalLimit;
    return result.entries;
};
export const scanWorkspaceEntries = async (cwd, options = {}) => loadDirectoryEntries(cwd, options);
export const getWorkspaceEntries = async () => {
    // The cache holds one root's entries, so a worktree switch has to drop it —
    // otherwise completion keeps offering paths from the checkout we just left.
    if (cachedEntries && cachedRoot !== workspaceRoot()) {
        cachedEntries = null;
    }
    if (!cachedEntries) {
        cachedRoot = workspaceRoot();
        cachedEntries = await loadWorkspaceEntries();
        lastLoadedAt = Date.now();
    }
    return cachedEntries;
};
export const refreshWorkspaceEntries = async () => {
    cachedEntries = null;
    return getWorkspaceEntries();
};
export const getWorkspaceEntriesMeta = () => ({
    lastLoadedAt,
    totalEntries: cachedEntries?.length ?? 0,
    truncated: lastLoadTruncated,
    truncatedByTotalLimit: lastLoadTruncatedByTotalLimit,
    limit: WORKSPACE_PATH_COMPLETION_ENTRY_LIMIT,
});
//# sourceMappingURL=file-service.js.map