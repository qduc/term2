import path from 'node:path';
import fs from 'node:fs';
import { ExecutionContext } from '../execution-context.js';
import { listGitWorktrees, listGitWorktreesSync, } from '../workspace/worktree-inventory.js';
import { resolveWorkerWorktree } from '../workspace/worktree-transition.js';
function describeAvailable(worktrees) {
    if (worktrees.length === 0) {
        return 'No enterable worktrees exist. Create one under the workspace root with `git worktree add .worktrees/<slug> -b <slug>`, then retry with worktree set to that slug or branch.';
    }
    return ('Available worktrees:\n' +
        worktrees
            .map((worktree) => {
            const name = path.basename(worktree.path);
            return worktree.branch ? `  - ${name} (branch ${worktree.branch})` : `  - ${name} (detached)`;
        })
            .join('\n'));
}
function formatResolveFailure(name, outcome) {
    switch (outcome.kind) {
        case 'not_found':
            return `Unknown worktree "${name}". ${describeAvailable(outcome.available)}`;
        case 'ambiguous':
            return (`Ambiguous worktree name "${name}" matches ${outcome.candidates.length} trees. ` +
                'Use the branch name to disambiguate:\n' +
                outcome.candidates
                    .map((worktree) => {
                    const dir = path.basename(worktree.path);
                    return worktree.branch ? `  - ${dir} (branch ${worktree.branch})` : `  - ${dir}`;
                })
                    .join('\n'));
        case 'unavailable':
            return `Worktree "${name}" is prunable (directory missing at ${outcome.worktree.path}). Recreate it or choose another worktree.`;
    }
}
/**
 * Resolves an existing worktree by name and returns a run-local
 * {@link ExecutionContext.pin} for a worker subagent. Never re-roots the
 * parent session or publishes the process-wide active workspace.
 */
export async function pinWorkerWorktree(params) {
    const { name, role, homeRoot, isRemote, listWorktrees = listGitWorktrees, authorizedPath } = params;
    if (role !== 'worker' && role !== 'agent') {
        return {
            ok: false,
            error: `worktree is only supported for role "worker" or a generic agent invocation (received "${role}"). Omit worktree or use a writable agent.`,
        };
    }
    if (isRemote) {
        return {
            ok: false,
            error: 'worktree pinning is not available in remote mode: the remote directory owns the execution root.',
        };
    }
    let worktrees;
    try {
        worktrees = await listWorktrees(homeRoot);
    }
    catch (error) {
        return {
            ok: false,
            error: `Could not list worktrees (${error?.message ?? error}). Is ${homeRoot} inside a git repository?`,
        };
    }
    const outcome = resolveWorkerWorktree(name, homeRoot, worktrees);
    if (outcome.kind !== 'resolved') {
        return { ok: false, error: formatResolveFailure(name, outcome) };
    }
    let resolvedRealPath;
    try {
        resolvedRealPath = fs.realpathSync(outcome.worktree.path);
    }
    catch {
        resolvedRealPath = path.resolve(outcome.worktree.path);
    }
    if (authorizedPath !== undefined) {
        // The snapshot already recorded the physical path. Re-resolving it here
        // would bless a symlink swapped into that same name after authorization.
        if (resolvedRealPath !== authorizedPath) {
            return {
                ok: false,
                error: `Worktree "${name}" resolved to ${outcome.worktree.path}, which does not match authorized path ${authorizedPath}.`,
            };
        }
    }
    return {
        ok: true,
        executionContext: ExecutionContext.pin(outcome.worktree.path),
        worktreePath: outcome.worktree.path,
        worktree: outcome.worktree,
    };
}
function createAuthorizedWorktreeScope(names, paths) {
    const scope = [...names];
    Object.defineProperty(scope, 'authorizedPaths', {
        value: Object.freeze({ ...paths }),
        enumerable: false,
        configurable: true,
    });
    return scope;
}
/**
 * Derives a finite host-owned allowlist of authorized worktree names for registered
 * in-repo worktrees. Fails closed (empty list) when remote, read-only, plan mode,
 * outside a git repo, or when worktree listing fails.
 */
export function deriveAuthorizedWorktreeScope(options) {
    const { homeRoot, isRemote = false, readOnly = false, planMode = false } = options;
    // Fail-closed for remote, read-only, or plan mode
    if (isRemote || readOnly || planMode) {
        return createAuthorizedWorktreeScope([], {});
    }
    let worktrees;
    if (options.worktrees) {
        worktrees = options.worktrees;
    }
    else {
        try {
            const listSync = options.listWorktreesSync ?? listGitWorktreesSync;
            worktrees = listSync(homeRoot);
        }
        catch {
            return createAuthorizedWorktreeScope([], {});
        }
    }
    if (!worktrees || worktrees.length === 0) {
        return createAuthorizedWorktreeScope([], {});
    }
    let physicalHomeRoot;
    try {
        physicalHomeRoot = fs.realpathSync(homeRoot);
    }
    catch {
        physicalHomeRoot = path.resolve(homeRoot);
    }
    const mainWorktree = worktrees.find((w) => !w.bare) ?? worktrees[0];
    let physicalRepoRoot;
    if (mainWorktree?.path) {
        try {
            physicalRepoRoot = fs.realpathSync(mainWorktree.path);
        }
        catch {
            physicalRepoRoot = path.resolve(mainWorktree.path);
        }
    }
    else {
        physicalRepoRoot = physicalHomeRoot;
    }
    const repoPrefix = physicalRepoRoot.endsWith(path.sep) ? physicalRepoRoot : `${physicalRepoRoot}${path.sep}`;
    const allowedNames = new Set();
    const authorizedPaths = {};
    for (const worktree of worktrees) {
        if (worktree.bare || worktree.prunable)
            continue;
        let candidatePath;
        try {
            candidatePath = fs.realpathSync(worktree.path);
        }
        catch {
            candidatePath = path.resolve(worktree.path);
        }
        // Must be physically inside the repository root and not the parent session homeRoot
        if (candidatePath === physicalHomeRoot || !candidatePath.startsWith(repoPrefix)) {
            continue;
        }
        const namesToTest = [];
        const base = path.basename(candidatePath);
        if (base)
            namesToTest.push(base);
        if (worktree.branch)
            namesToTest.push(worktree.branch);
        for (const name of namesToTest) {
            if (typeof name !== 'string' ||
                name.length === 0 ||
                name.includes('\0') ||
                path.isAbsolute(name) ||
                name.split(/[\\/]/).includes('..')) {
                continue;
            }
            const outcome = resolveWorkerWorktree(name, physicalHomeRoot, worktrees);
            if (outcome.kind !== 'resolved') {
                continue;
            }
            let resolvedPath;
            try {
                resolvedPath = fs.realpathSync(outcome.worktree.path);
            }
            catch {
                resolvedPath = path.resolve(outcome.worktree.path);
            }
            if (resolvedPath !== physicalHomeRoot && resolvedPath.startsWith(repoPrefix)) {
                allowedNames.add(name);
                authorizedPaths[name] = resolvedPath;
            }
        }
    }
    return createAuthorizedWorktreeScope([...allowedNames].sort(), authorizedPaths);
}
//# sourceMappingURL=worker-worktree.js.map