import { lstat as fsLstat, readdir as fsReaddir, realpath as fsRealpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
const DEFAULT_FILE_SYSTEM = {
    lstat: async (path) => fsLstat(path),
    realpath: async (path) => fsRealpath(path),
    readdir: async (path, options) => fsReaddir(path, options),
};
const HOOK_EXTENSIONS = new Set(['.js', '.mjs', '.ts']);
function isHookFileName(name) {
    return !name.endsWith('.d.ts') && HOOK_EXTENSIONS.has(extname(name));
}
function errorCode(error) {
    if (typeof error !== 'object' || error === null)
        return undefined;
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
}
function isMissing(error) {
    return errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR';
}
function lexicalCompare(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function isWithin(root, candidate) {
    return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
/**
 * Finds executable hook files without following symlinks. Discovery is kept
 * independent from SettingsService so its trust and executable-code policy is
 * not accidentally inherited by another kind of user-authored file.
 */
export class HookDiscovery {
    #options;
    #fs;
    constructor(options = {}) {
        this.#options = options;
        this.#fs = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
    }
    async discover() {
        const files = [];
        const diagnostics = [];
        const seen = new Set();
        let userRoot;
        let projectRoot;
        if (this.#options.userEnabled !== false) {
            const userBase = await this.#canonicalBase(this.#options.homeDir ?? homedir(), 'user', diagnostics);
            if (userBase) {
                userRoot = join(userBase, '.term2', 'hooks');
                await this.#scanRoot(userRoot, 'user', files, diagnostics, seen);
            }
        }
        else {
            diagnostics.push({
                code: 'hook_disabled',
                message: 'User hooks are disabled',
                source: { scope: 'user' },
            });
        }
        if (this.#options.projectEnabled !== false) {
            const projectBase = await this.#canonicalBase(this.#options.cwd ?? process.cwd(), 'project', diagnostics);
            if (projectBase) {
                projectRoot = join(projectBase, '.term2', 'hooks');
                if (await this.#isTrustedProject(projectBase)) {
                    await this.#scanRoot(projectRoot, 'project', files, diagnostics, seen);
                }
                else {
                    diagnostics.push({
                        code: 'project_hooks_untrusted',
                        message: 'Project hooks were skipped because the canonical project root is not trusted',
                        source: { path: projectBase, scope: 'project' },
                    });
                }
            }
        }
        else {
            diagnostics.push({
                code: 'hook_disabled',
                message: 'Project hooks are disabled',
                source: { scope: 'project' },
            });
        }
        return { files, userRoot, projectRoot, diagnostics };
    }
    #canonicalBase(candidate, scope, diagnostics) {
        return this.#canonicalBaseAsync(candidate, scope, diagnostics);
    }
    async #canonicalBaseAsync(candidate, scope, diagnostics) {
        const resolved = resolve(candidate);
        try {
            const stats = await this.#fs.lstat(resolved);
            if (stats.isSymbolicLink()) {
                diagnostics.push({
                    code: 'symlink_rejected',
                    message: 'Hook base directory symlinks are rejected',
                    source: { path: resolved, scope },
                });
                return undefined;
            }
            if (!stats.isDirectory()) {
                diagnostics.push({
                    code: 'discovery_failed',
                    message: 'Hook base path is not a directory',
                    source: { path: resolved, scope },
                });
                return undefined;
            }
            return await this.#fs.realpath(resolved);
        }
        catch (error) {
            if (isMissing(error))
                return undefined;
            diagnostics.push({
                code: 'discovery_failed',
                message: 'Could not canonicalize hook base directory',
                source: { path: resolved, scope },
                error,
            });
            return undefined;
        }
    }
    async #isTrustedProject(canonicalProjectRoot) {
        const roots = this.#options.trustedProjectRoots ?? [];
        for (const root of roots) {
            const resolved = resolve(root);
            try {
                if ((await this.#fs.realpath(resolved)) === canonicalProjectRoot)
                    return true;
            }
            catch (error) {
                if (!isMissing(error))
                    continue;
                // A missing persisted trust entry cannot match an existing canonical
                // cwd, but retaining this comparison makes injected filesystems with
                // virtual paths behave predictably.
                if (resolved === canonicalProjectRoot)
                    return true;
            }
        }
        return false;
    }
    async #scanRoot(root, scope, files, diagnostics, seen) {
        try {
            const parentStats = await this.#fs.lstat(dirname(root));
            if (parentStats.isSymbolicLink()) {
                diagnostics.push({
                    code: 'symlink_rejected',
                    message: 'Hook directory ancestors are rejected when symlinked',
                    source: { path: dirname(root), scope },
                });
                return;
            }
            const rootStats = await this.#fs.lstat(root);
            if (rootStats.isSymbolicLink()) {
                diagnostics.push({
                    code: 'symlink_rejected',
                    message: 'Hook directory symlinks are rejected',
                    source: { path: root, scope },
                });
                return;
            }
            if (!rootStats.isDirectory()) {
                diagnostics.push({
                    code: 'discovery_failed',
                    message: 'Hook path is not a directory',
                    source: { path: root, scope },
                });
                return;
            }
        }
        catch (error) {
            if (isMissing(error))
                return;
            diagnostics.push({
                code: 'discovery_failed',
                message: 'Could not inspect hook directory',
                source: { path: root, scope },
                error,
            });
            return;
        }
        let entries;
        try {
            entries = await this.#fs.readdir(root, { withFileTypes: true });
        }
        catch (error) {
            if (isMissing(error))
                return;
            diagnostics.push({
                code: 'discovery_failed',
                message: 'Could not scan hook directory',
                source: { path: root, scope },
                error,
            });
            return;
        }
        const sortedEntries = [...entries].sort((left, right) => lexicalCompare(left.name, right.name));
        for (const entry of sortedEntries) {
            const candidate = join(root, entry.name);
            if (entry.isSymbolicLink()) {
                diagnostics.push({
                    code: 'symlink_rejected',
                    message: 'Symlinked hook files are rejected',
                    source: { path: candidate, scope },
                });
                continue;
            }
            if (!entry.isFile() || !isHookFileName(entry.name))
                continue;
            try {
                // Re-check with lstat after readdir to avoid following a replacement
                // symlink if a hook directory changes during discovery.
                const stats = await this.#fs.lstat(candidate);
                if (stats.isSymbolicLink()) {
                    diagnostics.push({
                        code: 'symlink_rejected',
                        message: 'Symlinked hook files are rejected',
                        source: { path: candidate, scope },
                    });
                    continue;
                }
                if (!stats.isFile())
                    continue;
                const canonical = await this.#fs.realpath(candidate);
                if (!isWithin(root, canonical)) {
                    diagnostics.push({
                        code: 'symlink_rejected',
                        message: 'Hook path resolved outside its canonical hook directory',
                        source: { path: candidate, scope },
                    });
                    continue;
                }
                if (seen.has(canonical))
                    continue;
                seen.add(canonical);
                files.push({ path: canonical, scope, root });
            }
            catch (error) {
                if (isMissing(error))
                    continue;
                diagnostics.push({
                    code: 'discovery_failed',
                    message: 'Could not inspect hook file',
                    source: { path: candidate, scope },
                    error,
                });
            }
        }
    }
}
export async function discoverHookFiles(options = {}) {
    return new HookDiscovery(options).discover();
}
//# sourceMappingURL=hook-discovery.js.map