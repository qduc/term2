import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { CompletionProposal } from './contracts.js';

const execute = promisify(execFile);
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * A workspace shape the read-only verifier cannot attest. The reason travels to the
 * user and the log instead of collapsing into one generic verification failure.
 */
export class UnsupportedWorkspaceError extends Error {
  readonly reason: string;
  readonly detail?: string;
  constructor(reason: string, message: string, detail?: string) {
    super(message);
    this.name = 'UnsupportedWorkspaceError';
    this.reason = reason;
    this.detail = detail;
  }
}

export async function verificationGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const prefix = ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false'];
  const options = {
    cwd,
    signal,
    timeout: 10_000,
    maxBuffer: MAX_BYTES,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  };
  // Even diff --no-ext-diff --no-textconv can execute clean/process filters.
  // v1 explicitly blocks filtered workspaces instead of running repository-selected programs.
  if (args[0] === 'diff') {
    try {
      const filters = await execute(
        'git',
        [...prefix, 'config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$'],
        options,
      );
      if (filters.stdout.length > 0)
        throw new UnsupportedWorkspaceError(
          'executable-git-filters-unsupported',
          'Executable Git filters are configured; read-only verification cannot run repository-selected programs',
          filters.stdout,
        );
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1) throw error;
    }
  }
  const result = await execute('git', [...prefix, ...args], options);
  return result.stdout;
}

/** No shell, no writes, no symlink escape, bounded reads. Repository contents remain untrusted evidence. */
export async function readVerificationFile(root: string, filename: string): Promise<string> {
  const resolved = await realpath(path.resolve(root, filename));
  const relative = path.relative(await realpath(root), resolved);
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).some((part) => part === '.git' || part === 'node_modules')
  ) {
    throw new Error('Verification read outside permitted repository files');
  }
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Verification file is not a bounded regular file');
  return (await readFile(resolved, 'utf8')).slice(0, 64_000);
}

export type WorkspaceSnapshot = Pick<CompletionProposal, 'revision' | 'environment' | 'files' | 'classification'>;

/** The repository root, or an explicit unsupported-workspace reason when there is none. */
async function repositoryRoot(cwd: string): Promise<string> {
  try {
    return (await verificationGit(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === 'string' ? stderr.trim() : '';
    if (detail.includes('not a git repository'))
      throw new UnsupportedWorkspaceError(
        'not-a-git-repository',
        'the working directory is not inside a Git repository, so completion cannot be verified',
        detail,
      );
    throw error;
  }
}

/** Hash HEAD, staged/unstaged changes and untracked contents; a commit alone is insufficient. */
export async function snapshotWorkspace(cwd: string): Promise<WorkspaceSnapshot> {
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
    throw new UnsupportedWorkspaceError(
      'change-set-too-large',
      `the change set holds ${files.length} files, above the 512-file verification budget`,
    );
  let documentation = files.length > 0 && files.every((file) => /\.(md|txt|rst)$/i.test(file));
  if (documentation) {
    for (const file of files) {
      const entry = await verificationGit(root, ['ls-tree', 'HEAD', '--', file]);
      if (entry && !entry.startsWith('100644 ')) documentation = false;
      try {
        const stat = await lstat(path.join(root, file));
        if (!stat.isFile() || (stat.mode & 0o111) !== 0) documentation = false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!entry.startsWith('100644 ')) documentation = false;
      }
    }
  }
  const hash = createHash('sha256').update(head).update(diff);
  let bytes = Buffer.byteLength(diff);
  for (const file of untrackedFiles) {
    const resolved = path.resolve(root, file);
    const stat = await lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new UnsupportedWorkspaceError(
        'untracked-file-type-unsupported',
        `the untracked path ${file} is not a regular file`,
      );
    bytes += stat.size;
    if (bytes > MAX_BYTES)
      throw new UnsupportedWorkspaceError(
        'artifacts-too-large',
        'the untracked contents exceed the 2 MiB verification budget',
      );
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
