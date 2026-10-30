import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
const execute = promisify(execFile);
const MAX_BYTES = 2 * 1024 * 1024;
/** Tracked paths are probed in batches so the argument list stays inside ARG_MAX. */
const ATTRIBUTE_BATCH = 2000;
/** The tracked inventory is probe input rather than attested evidence, so it gets its own budget. */
const TRACKED_PATH_BUDGET = 16 * 1024 * 1024;
/**
 * A workspace shape the read-only verifier cannot attest. The reason travels to the
 * user and the log instead of collapsing into one generic verification failure.
 */
export class UnsupportedWorkspaceError extends Error {
    reason;
    detail;
    constructor(reason, message, detail) {
        super(message);
        this.name = 'UnsupportedWorkspaceError';
        this.reason = reason;
        this.detail = detail;
    }
}
/**
 * The filter names Git would actually run for the paths this repository tracks.
 *
 * A configured clean/process filter stays inert until an attribute binds a path to
 * it. Ambient configuration - a runner-wide "git lfs install --system", for
 * example - names a filter that no path selects, and must not block verification
 * of a repository that never uses it. Reachability decides the block.
 */
async function reachableFilterNames(probe, prefix) {
    const root = (await execute('git', [...prefix, 'rev-parse', '--show-toplevel'], probe)).stdout.trim();
    if (!root)
        return [];
    // The tracked inventory is probe input rather than attested evidence, so it
    // gets its own budget instead of the diff-content budget.
    const atRoot = { ...probe, cwd: root, maxBuffer: TRACKED_PATH_BUDGET };
    const tracked = await execute('git', [...prefix, 'ls-files', '-z', '--cached'], atRoot);
    const paths = tracked.stdout.split('\0').filter(Boolean);
    const names = new Set();
    for (let index = 0; index < paths.length; index += ATTRIBUTE_BATCH) {
        const batch = paths.slice(index, index + ATTRIBUTE_BATCH);
        const attributes = await execute('git', [...prefix, 'check-attr', '-z', 'filter', '--', ...batch], atRoot);
        // -z emits path\0attribute\0value\0 triples; only the value can name a filter.
        const fields = attributes.stdout.split('\0');
        for (let field = 2; field < fields.length; field += 3) {
            const value = fields[field];
            if (value && value !== 'unspecified' && value !== 'unset')
                names.add(value.toLowerCase());
        }
    }
    return [...names];
}
/** Block when a tracked path selects a filter whose clean/process program Git would run. */
async function assertNoExecutableFilters(probe, prefix) {
    const reachable = await reachableFilterNames(probe, prefix);
    if (reachable.length === 0)
        return;
    let configured;
    try {
        configured = (await execute('git', [...prefix, 'config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$'], probe)).stdout;
    }
    catch (error) {
        // git config --get-regexp exits 1 when nothing matches.
        if (error.code !== 1)
            throw error;
        return;
    }
    const configuredNames = configured
        .split('\0')
        .filter(Boolean)
        .map((key) => key
        .replace(/^filter\./, '')
        .replace(/\.(clean|process)$/, '')
        .toLowerCase());
    const matched = configuredNames.filter((name) => reachable.includes(name));
    if (matched.length === 0)
        return;
    throw new UnsupportedWorkspaceError('executable-git-filters-unsupported', 'Executable Git filters are configured; read-only verification cannot run repository-selected programs', matched.join(', '));
}
export async function verificationGit(cwd, args, signal) {
    const prefix = ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false'];
    const probe = {
        cwd,
        signal,
        timeout: 10_000,
        maxBuffer: MAX_BYTES,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    };
    // Even diff --no-ext-diff --no-textconv can execute clean/process filters.
    // v1 explicitly blocks filtered workspaces instead of running repository-selected programs.
    // --no-index compares two raw files outside the index and converts neither.
    if (args[0] === 'diff' && !args.includes('--no-index'))
        await assertNoExecutableFilters(probe, prefix);
    const result = await execute('git', [...prefix, ...args], probe);
    return result.stdout;
}
/** No shell, no writes, no symlink escape, bounded reads. Repository contents remain untrusted evidence. */
export async function readVerificationFile(root, filename) {
    const resolved = await realpath(path.resolve(root, filename));
    const relative = path.relative(await realpath(root), resolved);
    if (relative.startsWith(`..${path.sep}`) ||
        relative === '..' ||
        path.isAbsolute(relative) ||
        relative.split(path.sep).some((part) => part === '.git' || part === 'node_modules')) {
        throw new Error('Verification read outside permitted repository files');
    }
    const stat = await lstat(resolved);
    if (!stat.isFile() || stat.size > MAX_BYTES)
        throw new Error('Verification file is not a bounded regular file');
    return (await readFile(resolved, 'utf8')).slice(0, 64_000);
}
/** The repository root, or an explicit unsupported-workspace reason when there is none. */
async function repositoryRoot(cwd) {
    try {
        return (await verificationGit(cwd, ['rev-parse', '--show-toplevel'])).trim();
    }
    catch (error) {
        const stderr = error.stderr;
        const detail = typeof stderr === 'string' ? stderr.trim() : '';
        if (detail.includes('not a git repository'))
            throw new UnsupportedWorkspaceError('not-a-git-repository', 'the working directory is not inside a Git repository, so completion cannot be verified', detail);
        throw error;
    }
}
/** Hash HEAD, staged/unstaged changes and untracked contents; a commit alone is insufficient. */
export async function snapshotWorkspace(cwd) {
    const root = await repositoryRoot(cwd);
    const [head, diff, changed, untracked] = await Promise.all([
        verificationGit(root, ['rev-parse', 'HEAD']),
        verificationGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--']),
        verificationGit(root, ['diff', '--no-ext-diff', '--name-only', '-z', 'HEAD', '--']),
        verificationGit(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    const untrackedFiles = untracked.split('\0').filter(Boolean).sort();
    const files = [...new Set([...changed.split('\0').filter(Boolean), ...untrackedFiles])].sort();
    if (files.length > 512)
        throw new UnsupportedWorkspaceError('change-set-too-large', `the change set holds ${files.length} files, above the 512-file verification budget`);
    let documentation = files.length > 0 && files.every((file) => /\.(md|txt|rst)$/i.test(file));
    if (documentation) {
        for (const file of files) {
            const entry = await verificationGit(root, ['ls-tree', 'HEAD', '--', file]);
            if (entry && !entry.startsWith('100644 '))
                documentation = false;
            try {
                const stat = await lstat(path.join(root, file));
                if (!stat.isFile() || (stat.mode & 0o111) !== 0)
                    documentation = false;
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
                if (!entry.startsWith('100644 '))
                    documentation = false;
            }
        }
    }
    const hash = createHash('sha256').update(head).update(diff);
    let bytes = Buffer.byteLength(diff);
    for (const file of untrackedFiles) {
        const resolved = path.resolve(root, file);
        const stat = await lstat(resolved);
        if (!stat.isFile() || stat.isSymbolicLink())
            throw new UnsupportedWorkspaceError('untracked-file-type-unsupported', `the untracked path ${file} is not a regular file`);
        bytes += stat.size;
        if (bytes > MAX_BYTES)
            throw new UnsupportedWorkspaceError('artifacts-too-large', 'the untracked contents exceed the 2 MiB verification budget');
        hash
            .update(file)
            .update('\0')
            .update(await readFile(resolved));
    }
    return {
        revision: hash.digest('hex'),
        environment: await realpath(root),
        files,
        classification: files.length === 0 ? 'unknown' : documentation ? 'documentation' : 'code',
    };
}
//# sourceMappingURL=workspace.js.map