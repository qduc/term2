/**
 * A per-turn workspace snapshot for unattended approval
 * (docs/plans/approvals-and-sandbox/unattended-approval.md, part B).
 *
 * Snapshots live in a shadow git repository: a bare repository under term2's own state directory, used with
 * `--work-tree` pointed at the workspace. Nothing is written to the workspace or to its repository: no refs,
 * no objects, no index changes. Inside a git project the shadow work tree is the project's top level (so its
 * ignore rules apply), its index is seeded from the project's index, and its object store borrows the
 * project's through `objects/info/alternates`, so unchanged files are not stored twice. A workspace that is not
 * a git repository gets a shadow repository of its own. The state directory is outside the sandbox's writable
 * paths, so a sandboxed agent cannot delete the snapshots.
 *
 * Guard: cost and retention bounds. A snapshot stores new and changed non-ignored files, so it is skipped
 * (with a notice) when those exceed CHANGED_BYTES_LIMIT, and every git step and the whole snapshot have a
 * deadline. Only the newest SNAPSHOT_KEEP snapshot refs of a workspace are kept; `git gc --auto` then reclaims
 * what older ones held. A snapshot never fails or blocks a turn: every failure becomes `{ kind: 'none' }`.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { sandboxUserStateRoot } from '../shell/sandbox/sandbox-project.js';

const run = promisify(execFile);

const SNAPSHOT_REF_PREFIX = 'refs/snapshots/';
/** Snapshot refs kept per workspace; older ones are deleted when a new one is written. */
const SNAPSHOT_KEEP = 20;
/** New and changed non-ignored bytes above this skip the snapshot rather than store them. */
const CHANGED_BYTES_LIMIT = 256 * 1024 * 1024;
/** Each git step's deadline, and the whole snapshot's; the snapshot is skipped when one is exceeded. */
const STEP_TIMEOUT_MS = 30_000;
const TAKE_TIMEOUT_MS = 60_000;
/** The end-of-turn listing runs synchronously at turn end, so its deadline is shorter. */
const REPORT_TIMEOUT_MS = 10_000;
const REPORT_MAX_FILES = 20;
const SIZE_REASON = `new and changed files exceed ${CHANGED_BYTES_LIMIT / (1024 * 1024)} MiB, the snapshot size bound`;

export type WorkspaceSnapshot =
  | {
      readonly kind: 'taken';
      /** The shadow repository. */
      readonly gitDir: string;
      /** The tree the snapshot holds: the project's top level, or the workspace when it is not in a repository. */
      readonly workTree: string;
      /** The workspace directory; the change list and the restore command are limited to it. */
      readonly cwd: string;
      readonly ref: string;
      readonly commit: string;
    }
  | { readonly kind: 'none'; readonly reason: string };

type Shadow = { readonly gitDir: string; readonly workTree: string };

/** Never prompt, never take optional locks, and never depend on the user's identity or signing setup. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete env[key];
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: 'term2',
    GIT_AUTHOR_EMAIL: 'term2@localhost',
    GIT_COMMITTER_NAME: 'term2',
    GIT_COMMITTER_EMAIL: 'term2@localhost',
  };
}

const shadowArgs = (shadow: Shadow, args: readonly string[]): string[] => [
  `--git-dir=${shadow.gitDir}`,
  `--work-tree=${shadow.workTree}`,
  ...args,
];

async function git(cwd: string, args: readonly string[], deadline: number): Promise<string> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`exceeded ${TAKE_TIMEOUT_MS / 1000} s`);
  const { stdout } = await run('git', [...args], {
    cwd,
    env: gitEnv(),
    timeout: Math.min(STEP_TIMEOUT_MS, remaining),
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
}

function gitSync(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    env: gitEnv(),
    timeout: REPORT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** Git argument lists a step sequence asks for, run against the shadow repository by an async or sync driver. */
type Steps<T> = Generator<readonly string[], T, string>;

async function runSteps<T>(steps: Steps<T>, step: (args: readonly string[]) => Promise<string>): Promise<T> {
  let next = steps.next();
  while (!next.done) next = steps.next(await step(next.value));
  return next.value;
}

function runStepsSync<T>(steps: Steps<T>, step: (args: readonly string[]) => string): T {
  let next = steps.next();
  while (!next.done) next = steps.next(step(next.value));
  return next.value;
}

/** Whether the bytes `git add -A` would store (untracked and modified, not ignored) stay within the bound. */
function* changesWithinBound(workTree: string): Steps<boolean> {
  const listed = [
    ...(yield ['ls-files', '-o', '--exclude-standard', '-z']).split('\0'),
    ...(yield ['ls-files', '-m', '-z']).split('\0'),
  ].filter(Boolean);
  let bytes = 0;
  for (const file of new Set(listed)) {
    try {
      bytes += fs.lstatSync(path.join(workTree, file)).size;
    } catch {
      // A file that vanished is not stored either.
    }
    if (bytes > CHANGED_BYTES_LIMIT) return false;
  }
  return true;
}

/** The shadow repository's directory for one work tree, created only along a trusted path. */
function shadowDirectory(stateRoot: string, workTree: string): string {
  const key = createHash('sha256').update(workTree).digest('hex').slice(0, 24);
  const directory = path.join(stateRoot, 'workspace-snapshots', key);
  let parent = directory;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  if (fs.realpathSync(parent) !== parent) throw new Error('the snapshot directory is behind a symbolic link');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/**
 * Create the shadow repository the first time. In a git project: borrow its object store, copy its index
 * (keeping the index's mtime, so git's racy-clean check still rechecks same-second edits) with
 * `assume-unchanged` and present `skip-worktree` entries cleared, so the snapshot holds what is on disk.
 */
async function* initShadow(
  shadow: Shadow,
  project: Project | undefined,
): AsyncGenerator<readonly string[], void, string> {
  yield ['init', '-q', '--bare', shadow.gitDir];
  if (!project) return;
  fs.writeFileSync(path.join(shadow.gitDir, 'objects', 'info', 'alternates'), `${project.objects}\n`);
  if (!fs.existsSync(project.index)) return;
  const index = path.join(shadow.gitDir, 'index');
  fs.copyFileSync(project.index, index);
  const { atime, mtime } = fs.statSync(project.index);
  fs.utimesSync(index, atime, mtime);
  const assume: string[] = [];
  const skip: string[] = [];
  for (const entry of (yield shadowArgs(shadow, ['ls-files', '-v', '-z'])).split('\0').filter(Boolean)) {
    const tag = entry[0]!;
    const file = entry.slice(2);
    if (tag >= 'a' && tag <= 'z') assume.push(file);
    if ((tag === 'S' || tag === 's') && fs.existsSync(path.join(shadow.workTree, file))) skip.push(file);
  }
  for (const [flag, files] of [
    ['--no-assume-unchanged', assume],
    ['--no-skip-worktree', skip],
  ] as const)
    for (let at = 0; at < files.length; at += 500)
      yield shadowArgs(shadow, ['update-index', flag, '--', ...files.slice(at, at + 500)]);
}

type Project = {
  readonly topLevel: string;
  readonly objects: string;
  readonly index: string;
  readonly exclude: string;
};

/** The git project containing `cwd`, or undefined when there is none. */
async function findProject(cwd: string, deadline: number): Promise<Project | undefined> {
  let lines: string[];
  try {
    lines = (await git(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir', '--git-path', 'index'], deadline))
      .split('\n')
      .filter(Boolean);
  } catch {
    return undefined;
  }
  const [topLevel, commonDir, index] = lines;
  if (!topLevel || !commonDir || !index) return undefined;
  const common = path.resolve(cwd, commonDir);
  return {
    topLevel: fs.realpathSync(topLevel),
    objects: path.join(common, 'objects'),
    index: path.resolve(cwd, index),
    exclude: path.join(common, 'info', 'exclude'),
  };
}

function refLabel(label: string): string {
  return (
    label
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 80) || 'turn'
  );
}

/** Write the snapshot commit and its ref in the shadow repository; prune older snapshots. Never throws. */
export async function takeWorkspaceSnapshot(
  cwd: string,
  label: string,
  stateRoot: string = sandboxUserStateRoot(),
): Promise<WorkspaceSnapshot> {
  const deadline = Date.now() + TAKE_TIMEOUT_MS;
  try {
    const workspace = fs.realpathSync(cwd);
    const project = await findProject(workspace, deadline);
    const workTree = project?.topLevel ?? workspace;
    const shadow: Shadow = { gitDir: shadowDirectory(stateRoot, workTree), workTree };
    const step = (args: readonly string[]): Promise<string> => git(workTree, args, deadline);
    const shadowStep = (args: readonly string[]): Promise<string> => step(shadowArgs(shadow, args));
    if (!fs.existsSync(path.join(shadow.gitDir, 'HEAD'))) {
      const init = initShadow(shadow, project);
      let next = await init.next();
      while (!next.done) next = await init.next(await step(next.value));
    }
    // The project's own exclude file applies to the shadow too; refreshed each time it may have changed.
    const exclude = project && fs.existsSync(project.exclude) ? fs.readFileSync(project.exclude, 'utf8') : '';
    fs.mkdirSync(path.join(shadow.gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(shadow.gitDir, 'info', 'exclude'), exclude);
    if (!(await runSteps(changesWithinBound(workTree), shadowStep))) return { kind: 'none', reason: SIZE_REASON };
    await shadowStep(['add', '-A', '--', '.']);
    const tree = (await shadowStep(['write-tree'])).trim();
    const commit = (
      await shadowStep(['commit-tree', '--no-gpg-sign', tree, '-m', `term2 unattended snapshot before ${label}`])
    ).trim();
    const ref = `${SNAPSHOT_REF_PREFIX}${Date.now()}-${refLabel(label)}`;
    await shadowStep(['update-ref', ref, commit]);
    await prune(shadowStep).catch(() => undefined);
    return { kind: 'taken', gitDir: shadow.gitDir, workTree, cwd: workspace, ref, commit };
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return { kind: 'none', reason: `the snapshot failed (${message})` };
  }
}

/**
 * Keep the newest SNAPSHOT_KEEP refs (names start with a millisecond timestamp, so name order is age order),
 * then let git reclaim what dropped refs held.
 */
async function prune(step: (args: readonly string[]) => Promise<string>): Promise<void> {
  const refs = (await step(['for-each-ref', '--sort=-refname', '--format=%(refname)', SNAPSHOT_REF_PREFIX]))
    .split('\n')
    .filter(Boolean);
  for (const ref of refs.slice(SNAPSHOT_KEEP)) await step(['update-ref', '-d', ref]);
  await step(['gc', '--auto', '--quiet']);
}

/** Puts modified and deleted files under the workspace back as they were; `--overlay` never removes a file. */
function restoreCommand(snapshot: Extract<WorkspaceSnapshot, { kind: 'taken' }>): string {
  return [
    'git',
    `-C ${JSON.stringify(snapshot.cwd)}`,
    `--git-dir=${JSON.stringify(snapshot.gitDir)}`,
    `--work-tree=${JSON.stringify(snapshot.workTree)}`,
    `restore --overlay --source=${snapshot.ref} --worktree -- .`,
  ].join(' ');
}

/**
 * The end-of-turn lines: which snapshot, what changed since it under the workspace, and how to restore.
 * Synchronous and bounded (REPORT_TIMEOUT_MS per step, the size bound); a listing that cannot run says so.
 */
export function describeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): string {
  if (snapshot.kind === 'none') return `No workspace snapshot for this turn: ${snapshot.reason}.`;
  const shadow: Shadow = { gitDir: snapshot.gitDir, workTree: snapshot.workTree };
  let changes: string;
  try {
    const step = (args: readonly string[]): string => gitSync(snapshot.workTree, shadowArgs(shadow, args));
    // Stages what the turn left in the shadow index, so the next snapshot starts from it; same size bound.
    if (!runStepsSync(changesWithinBound(snapshot.workTree), step)) throw new Error(SIZE_REASON);
    step(['add', '-A', '--', '.']);
    // From the workspace directory with `--relative`, as the restore command runs.
    const lines = gitSync(
      snapshot.cwd,
      shadowArgs(shadow, [
        'diff',
        '--cached',
        '--no-renames',
        '--relative',
        '--name-status',
        snapshot.commit,
        '--',
        '.',
      ]),
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
  }
  return [
    `Workspace snapshot before this turn: ${snapshot.ref} (${snapshot.commit.slice(
      0,
      12,
    )}), kept outside the workspace.`,
    changes,
    `To put back modified and deleted files: ${restoreCommand(snapshot)}`,
    'The restore never deletes a file: files the turn created (A above) stay until you remove them.',
  ].join('\n');
}
