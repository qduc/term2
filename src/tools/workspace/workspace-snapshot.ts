/**
 * A per-turn workspace snapshot for unattended approval
 * (docs/plans/approvals-and-sandbox/unattended-approval.md, part B).
 *
 * The snapshot is a commit of the tracked, staged and untracked non-ignored
 * files, written with a temporary index under a private ref, so HEAD, branches,
 * the index, the working tree and the stash are untouched. It guards against
 * mistakes inside the sandbox, not against an agent that deletes the ref: the
 * repository is writable from the sandbox.
 *
 * Guard: cost and retention bounds. A snapshot copies untracked files into the
 * object store, so it is skipped (with a notice) when untracked files exceed
 * UNTRACKED_BYTES_LIMIT, and every git step has a deadline. Only the newest
 * SNAPSHOT_KEEP snapshot refs of a repository are kept; older refs are deleted
 * and their objects left to git's own garbage collection. A snapshot never
 * fails or blocks a turn: every failure becomes `{ kind: 'none', reason }`.
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SNAPSHOT_REF_PREFIX = 'refs/term2/snapshots/';
/** Snapshot refs kept per repository; older ones are deleted when a new one is written. */
const SNAPSHOT_KEEP = 20;
/** Untracked bytes above this skip the snapshot rather than copy them into the object store. */
const UNTRACKED_BYTES_LIMIT = 256 * 1024 * 1024;
/** Each git step's deadline, and the whole snapshot's; the snapshot is skipped when one is exceeded. */
const STEP_TIMEOUT_MS = 30_000;
const TAKE_TIMEOUT_MS = 60_000;
/** The end-of-turn listing runs synchronously at turn end, so its deadline is shorter. */
const REPORT_TIMEOUT_MS = 10_000;
const REPORT_MAX_FILES = 20;

export type WorkspaceSnapshot =
  | {
      readonly kind: 'taken';
      /** The repository's top level, whose whole tree the commit holds. */
      readonly root: string;
      /** The workspace directory; the change list and the restore command are limited to it. */
      readonly cwd: string;
      readonly ref: string;
      readonly commit: string;
    }
  | { readonly kind: 'none'; readonly reason: string };

/** Never prompt, never take optional locks, and never depend on the user's identity or signing setup. */
function gitEnv(index?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: 'term2',
    GIT_AUTHOR_EMAIL: 'term2@localhost',
    GIT_COMMITTER_NAME: 'term2',
    GIT_COMMITTER_EMAIL: 'term2@localhost',
    ...(index ? { GIT_INDEX_FILE: index } : {}),
  };
}

async function git(cwd: string, args: readonly string[], index?: string, deadline?: number): Promise<string> {
  const remaining = deadline === undefined ? STEP_TIMEOUT_MS : deadline - Date.now();
  if (remaining <= 0) throw new Error(`exceeded ${TAKE_TIMEOUT_MS / 1000} s`);
  const { stdout } = await run('git', [...args], {
    cwd,
    env: gitEnv(index),
    timeout: Math.min(STEP_TIMEOUT_MS, remaining),
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
}

function gitSync(cwd: string, args: readonly string[], index?: string): string {
  return execFileSync('git', [...args], {
    cwd,
    env: gitEnv(index),
    timeout: REPORT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** A copy of the real index in a private temporary folder, so `git add` never touches the real one. */
function temporaryIndex(root: string, gitPathIndex: string): { readonly file: string; dispose(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-snapshot-'));
  const file = path.join(dir, 'index');
  const real = path.resolve(root, gitPathIndex.trim());
  if (fs.existsSync(real)) {
    fs.copyFileSync(real, file);
    // Keep the real index's mtime: git rechecks entries not older than the index ("racily clean"). A fresh
    // mtime would make it trust stat data and miss a same-size edit made in the same second.
    const { atime, mtime } = fs.statSync(real);
    fs.utimesSync(file, atime, mtime);
  }
  return { file, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** One git invocation a step sequence asks for: arguments and, optionally, the temporary index to use. */
type GitStep = { readonly args: readonly string[]; readonly index?: string };
type Steps<T> = Generator<GitStep, T, string>;

async function runSteps<T>(steps: Steps<T>, run: (step: GitStep) => Promise<string>): Promise<T> {
  let next = steps.next();
  while (!next.done) next = steps.next(await run(next.value));
  return next.value;
}

function runStepsSync<T>(steps: Steps<T>, run: (step: GitStep) => string): T {
  let next = steps.next();
  while (!next.done) next = steps.next(run(next.value));
  return next.value;
}

/** Whether untracked, non-ignored files stay within UNTRACKED_BYTES_LIMIT. */
function* untrackedWithinBound(root: string): Steps<boolean> {
  const untracked = (yield { args: ['ls-files', '-o', '--exclude-standard', '-z'] }).split('\0').filter(Boolean);
  let bytes = 0;
  for (const file of untracked) {
    try {
      bytes += fs.lstatSync(path.join(root, file)).size;
    } catch {
      // A file that vanished is not copied either.
    }
    if (bytes > UNTRACKED_BYTES_LIMIT) return false;
  }
  return true;
}

/**
 * Stage the working tree into the temporary index. `assume-unchanged` and (present) `skip-worktree` entries are
 * cleared there first, so the commit holds what is on disk for them, not the index version a restore would
 * write over a local edit with.
 */
function* stageWorkingTree(root: string, index: string): Steps<void> {
  const assume: string[] = [];
  const skip: string[] = [];
  for (const entry of (yield { args: ['ls-files', '-v', '-z'], index }).split('\0').filter(Boolean)) {
    const tag = entry[0]!;
    const file = entry.slice(2);
    if (tag >= 'a' && tag <= 'z') assume.push(file);
    if ((tag === 'S' || tag === 's') && fs.existsSync(path.join(root, file))) skip.push(file);
  }
  for (const [flag, files] of [
    ['--no-assume-unchanged', assume],
    ['--no-skip-worktree', skip],
  ] as const)
    for (let at = 0; at < files.length; at += 500)
      yield { args: ['update-index', flag, '--', ...files.slice(at, at + 500)], index };
  yield { args: ['add', '-A', '--', '.'], index };
}

const UNTRACKED_REASON = `untracked files exceed ${UNTRACKED_BYTES_LIMIT / (1024 * 1024)} MiB, the snapshot size bound`;

function refLabel(label: string): string {
  return (
    label
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 80) || 'turn'
  );
}

/** Write the snapshot commit and its ref; prune older snapshots. Never throws. */
export async function takeWorkspaceSnapshot(cwd: string, label: string): Promise<WorkspaceSnapshot> {
  let root: string;
  try {
    root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    if (!root) throw new Error('no top level');
  } catch {
    return { kind: 'none', reason: 'the workspace is not a git repository' };
  }
  let index: ReturnType<typeof temporaryIndex> | undefined;
  const deadline = Date.now() + TAKE_TIMEOUT_MS;
  const gitRun = (args: readonly string[], file?: string): Promise<string> => git(root, args, file, deadline);
  const step = (next: GitStep): Promise<string> => gitRun(next.args, next.index);
  try {
    if (!(await runSteps(untrackedWithinBound(root), step))) return { kind: 'none', reason: UNTRACKED_REASON };
    index = temporaryIndex(root, await gitRun(['rev-parse', '--git-path', 'index']));
    await runSteps(stageWorkingTree(root, index.file), step);
    const tree = (await gitRun(['write-tree'], index.file)).trim();
    let parent: string | undefined;
    try {
      parent = (await gitRun(['rev-parse', '--verify', '-q', 'HEAD'])).trim() || undefined;
    } catch {
      parent = undefined;
    }
    const commit = (
      await gitRun([
        'commit-tree',
        '--no-gpg-sign',
        tree,
        ...(parent ? ['-p', parent] : []),
        '-m',
        `term2 unattended snapshot before ${label}`,
      ])
    ).trim();
    const ref = `${SNAPSHOT_REF_PREFIX}${Date.now()}-${refLabel(label)}`;
    await gitRun(['update-ref', ref, commit]);
    await prune(root).catch(() => undefined);
    return { kind: 'taken', root, cwd: path.resolve(cwd), ref, commit };
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return { kind: 'none', reason: `the snapshot failed (${message})` };
  } finally {
    index?.dispose();
  }
}

/** Keep the newest SNAPSHOT_KEEP refs; names start with a millisecond timestamp, so name order is age order. */
async function prune(root: string): Promise<void> {
  const refs = (await git(root, ['for-each-ref', '--sort=-refname', '--format=%(refname)', SNAPSHOT_REF_PREFIX]))
    .split('\n')
    .filter(Boolean);
  for (const ref of refs.slice(SNAPSHOT_KEEP)) await git(root, ['update-ref', '-d', ref]);
}

/** The command that puts modified and deleted files back as they were in the snapshot. */
function restoreCommand(snapshot: Extract<WorkspaceSnapshot, { kind: 'taken' }>): string {
  return `git -C ${JSON.stringify(snapshot.cwd)} restore --source=${snapshot.ref} --worktree -- .`;
}

/**
 * The end-of-turn lines: which snapshot, what changed since it, and how to restore. Synchronous and
 * bounded (REPORT_TIMEOUT_MS); a listing that fails says so instead of the files.
 */
export function describeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): string {
  if (snapshot.kind === 'none') return `No workspace snapshot for this turn: ${snapshot.reason}.`;
  let changes: string;
  let index: ReturnType<typeof temporaryIndex> | undefined;
  const step = (next: GitStep): string => gitSync(snapshot.root, next.args, next.index);
  try {
    // The listing stages what the turn left, so it keeps the snapshot's size bound.
    if (!runStepsSync(untrackedWithinBound(snapshot.root), step)) throw new Error(UNTRACKED_REASON);
    index = temporaryIndex(snapshot.root, gitSync(snapshot.root, ['rev-parse', '--git-path', 'index']));
    runStepsSync(stageWorkingTree(snapshot.root, index.file), step);
    // Only the workspace directory, with paths relative to it, as the restore command is.
    const lines = gitSync(
      snapshot.cwd,
      ['diff', '--cached', '--no-renames', '--relative', '--name-status', snapshot.commit, '--', '.'],
      index.file,
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => line.replace('\t', ' '));
    changes =
      lines.length === 0
        ? 'No files changed since it.'
        : [
            `Files changed since it (${lines.length}):`,
            ...lines.slice(0, REPORT_MAX_FILES).map((line) => `  ${line}`),
            ...(lines.length > REPORT_MAX_FILES ? [`  … and ${lines.length - REPORT_MAX_FILES} more`] : []),
          ].join('\n');
  } catch {
    changes = 'The files changed since it could not be listed.';
  } finally {
    index?.dispose();
  }
  return [
    `Workspace snapshot before this turn: ${snapshot.ref} (${snapshot.commit.slice(0, 12)}).`,
    changes,
    `To put back modified and deleted files: ${restoreCommand(snapshot)}`,
    'The restore leaves the index alone and keeps files the turn created, except ones it added to the index, which it removes from the working tree.',
  ].join('\n');
}
