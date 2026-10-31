/**
 * Copy one authorized logical conversation into a new physical lineage in the same
 * conversations-next directory. Copied envelopes keep their original `at`
 * and every accepted fact, including goal, queue, memory, branch and task
 * facts. ConversationLog.append is not used for those lines because it
 * stamps a new clock. Replay recovery for an open turn, queue or branch is
 * appended only on the copy. Background task recovery is not written here;
 * opening the copy and admitting new work does that under normal Session
 * policy. The source is never opened for write, and no live runtime, task
 * or tool is started.
 *
 * Stored workspaceIdentity is only a hint. The resolver returns the current
 * grant, which must match that hint's root, target and access. A path-only
 * source matches only a current local grant. The copy persists that grant,
 * not a path relabel and not the old record.
 *
 * Requires the lead fact/log contracts: readFactLines, the widened Fact
 * union, native session_started.forkedFrom, and replay that understands
 * that vocabulary.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ModelRef } from '../model/index.js';
import type { Workspace } from '../tools/index.js';
import type { DirectBinding } from './facade-types.js';
import { LOG_FORMAT_VERSION, type Fact, type FactLine, type SessionStartedFact } from './facts.js';
import { readFactLines } from './log.js';
import { readDirectLogLineage } from './direct-rolling-log.js';
import { latestDirectConfiguration } from './direct-configuration.js';
import { replay } from './replay.js';

const DIRECT_ID = /^conv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DirectForkRequest = {
  /** The direct store directory. Never the old conversations directory. */
  readonly directory: string;
  readonly sourceId: string;
  /**
   * Same authorization as DirectSessionStore.open. A supplied binding must
   * match session_started.binding. Omitting it does not rebind or drop it.
   */
  readonly expectedBinding?: DirectBinding;
  /**
   * Same resolver passed to createDirectSessionStore. The identity argument
   * is the preserved grant hint, never authority by itself.
   */
  readonly resolveWorkspace: (root: string, identity?: Workspace) => Workspace | Promise<Workspace>;
};

export type DirectForkResult = {
  readonly sourceId: string;
  readonly id: string;
  readonly workspace: Workspace;
  readonly model: ModelRef;
  readonly binding?: DirectBinding;
  readonly status: 'idle' | 'interrupted';
  /** Recovery facts written on the fork only. Zero when replay was already stable. */
  readonly materializedRecovery: number;
};

type ForkedStart = SessionStartedFact & {
  readonly forkedFrom: string;
  readonly workspaceIdentity: Workspace;
};

/**
 * Resolves a logical or physical alias through its accepted head. Throws when
 * the source is missing, unauthorized, foreign, or not a valid
 * replay, or when the current grant does not match the stored identity.
 * Those failures happen before the new log is created. A failed write is
 * deleted, including earlier copied segments. Success returns the new logical
 * id and does not modify the source. A process death may leave an accepted fork
 * prefix, just as a killed single-file copy may leave a terminated prefix.
 */
export async function forkDirectConversation(request: DirectForkRequest): Promise<DirectForkResult> {
  if (typeof request.directory !== 'string' || request.directory.length === 0) {
    throw new Error('direct fork requires the direct conversations directory');
  }
  if (typeof request.resolveWorkspace !== 'function') {
    throw new Error('direct fork requires the store workspace resolver');
  }
  const sourceId = request.sourceId;
  requireDirectId(sourceId);
  const expected = request.expectedBinding === undefined ? undefined : structuredClone(request.expectedBinding);
  validateBinding(expected);

  const directory = path.resolve(request.directory);
  await assertDirectDirectory(directory, sourceId);
  const lineage = readDirectLogLineage(directory, sourceId);
  const sourceLines = lineage.entries;
  const metadata = lineage.metadata;
  validateExpectedBinding(metadata.binding, expected);
  // Reject a log this Session cannot replay before any new file exists.
  // Clone first so projection cannot alias the envelopes we copy.
  replay(sourceLines.map((line) => structuredClone(line.fact)));
  const workspace = await resolveAuthority(request.resolveWorkspace, metadata.workspace, storedIdentity(metadata));
  const id = newDirectId();
  const physicalIds = new Map(
    lineage.segments.map((segment, index) => [segment.sessionId, index === 0 ? id : newDirectId()]),
  );
  const copied = sourceLines.map((line) => ({
    v: line.v,
    seq: line.seq,
    at: line.at,
    fact: retargetFact(line.fact, lineage.logicalSessionId, id, workspace, physicalIds, sourceId),
  }));
  const projected = replay(copied.map((line) => line.fact));
  const stampedAt = new Date().toISOString();
  const recovery = projected.recoveryFacts.map((fact, index) => ({
    v: LOG_FORMAT_VERSION,
    seq: copied.at(-1)!.seq + index + 1,
    at: stampedAt,
    fact,
  }));
  const lines = [...copied, ...recovery];
  const stable = replay(lines.map((line) => line.fact));
  if (stable.recoveryFacts.length !== 0) throw new Error('direct fork replay did not settle');
  const created: string[] = [];
  try {
    for (const [index, segment] of lineage.segments.entries()) {
      const destinationId = physicalIds.get(segment.sessionId)!;
      const isHead = index === lineage.segments.length - 1;
      const segmentLines = lines.filter(
        (line) => line.seq > segment.afterSeq && (isHead || line.seq <= segment.throughSeq),
      );
      await writeFork(directory, sourceId, destinationId, segmentLines, segment.afterSeq);
      created.push(destinationId);
    }
    // Validate the copied physical links as well as the combined replay. Nothing
    // from the source is opened as a writer or resumed while copying.
    const readBack = readDirectLogLineage(directory, id);
    if (readBack.entries.length !== lines.length || readBack.segments.length !== lineage.segments.length)
      throw new Error('direct fork did not retain its complete physical lineage');
    if (
      provenanceOf(readBack.metadata) !== sourceId ||
      !sameExactGrant(workspaceIdentityOf(readBack.metadata), workspace)
    )
      throw new Error('direct fork lost its provenance or workspace grant');
    if (replay(readBack.entries.map((line) => line.fact)).recoveryFacts.length !== 0)
      throw new Error('direct fork replay did not settle');
  } catch (error) {
    const failures: unknown[] = [error];
    // Only files this invocation actually created are eligible for cleanup.
    for (const destinationId of created.reverse()) {
      try {
        await unlink(logPath(directory, destinationId));
      } catch (cleanup) {
        if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') failures.push(cleanup);
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'direct fork failed and copied lineage cleanup failed');
    throw error;
  }

  const started = lines[0]?.fact;
  if (started?.type !== 'session_started') throw new Error('direct fork lost its session_started fact');
  return {
    sourceId,
    id,
    workspace,
    model: structuredClone(
      latestDirectConfiguration(lines.map((line) => line.fact))?.configuration.model ?? started.model,
    ),
    ...(started.binding ? { binding: structuredClone(started.binding) } : {}),
    status: stable.status,
    materializedRecovery: recovery.length,
  };
}

/** Store rule: only exact conv_<uuid>.jsonl files, and never open a foreign name. */
async function assertDirectDirectory(directory: string, sourceId: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('direct fork source directory does not exist', { cause: error });
    }
    throw error;
  }
  let found = false;
  for (const name of names) {
    if (!name.endsWith('.jsonl') || !DIRECT_ID.test(name.slice(0, -'.jsonl'.length))) {
      throw new Error(`refusing direct conversations directory with foreign entry ${JSON.stringify(name)}`);
    }
    if (!(await lstat(path.join(directory, name))).isFile()) {
      throw new Error(`direct log is not a regular file: ${name}`);
    }
    if (name === `${sourceId}.jsonl`) found = true;
  }
  if (!found) throw new Error(`direct fork source ${sourceId} does not exist`);
}

/**
 * New conversation id and current workspace grant. Task ownership follows that
 * id so replay does not treat the copy as another Session. Memory sourceSessionId
 * and task workspace snapshots stay recorded provenance and are not rewritten.
 * forkedFrom is the immediate source, on the single session_started fact.
 * The persisted identity is the current grant, never the source's old record.
 */
function retargetFact(
  fact: Fact,
  sourceId: string,
  id: string,
  authority: Workspace,
  physicalIds: ReadonlyMap<string, string>,
  provenanceSourceId: string,
): Fact {
  const copy = structuredClone(fact);
  if (copy.type === 'session_started') {
    if (copy.id !== sourceId) {
      throw new Error(`direct Session ${sourceId} has invalid or mismatched session_started metadata`);
    }
    const started: ForkedStart = {
      ...copy,
      id,
      workspace: authority.root,
      workspaceIdentity: { root: authority.root, target: authority.target, access: authority.access },
      forkedFrom: provenanceSourceId,
    };
    return started;
  }
  if (copy.type === 'session_rotated') {
    const sessionId = physicalIds.get(copy.sessionId);
    const predecessorId = physicalIds.get(copy.predecessor.sessionId);
    if (copy.logicalSessionId !== sourceId || !sessionId || !predecessorId)
      throw new Error('direct fork rotation is outside the verified source lineage');
    return { ...copy, logicalSessionId: id, sessionId, predecessor: { ...copy.predecessor, sessionId: predecessorId } };
  }
  if (copy.type === 'command_finished' && copy.outcome.kind === 'rolled_over' && copy.outcome.sessionId === sourceId)
    return { ...copy, outcome: { ...copy.outcome, sessionId: id } };
  if (copy.type === 'task_started') {
    if (copy.task.sessionId !== sourceId) {
      throw new Error('direct fork task belongs to a different Session');
    }
    return { ...copy, task: { ...copy.task, sessionId: id } };
  }
  if (copy.type === 'task_interaction_opened') {
    if (copy.request.sessionId !== sourceId) {
      throw new Error('direct fork task interaction belongs to a different Session');
    }
    return { ...copy, request: { ...copy.request, sessionId: id } };
  }
  return copy;
}

async function writeFork(
  directory: string,
  sourceId: string,
  id: string,
  lines: readonly FactLine[],
  afterSeq: number,
): Promise<void> {
  const target = logPath(directory, id);
  if (id === sourceId || path.resolve(target) === path.resolve(logPath(directory, sourceId))) {
    throw new Error('direct fork refused to write the source log');
  }
  const payload = Buffer.from(lines.map(serializeLine).join(''), 'utf8');
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(target, 'wx');
    created = true;
    let offset = 0;
    while (offset < payload.length) {
      const written = writeSync(fd, payload, offset, payload.length - offset);
      if (written <= 0) throw new Error(`short write: wrote ${written} of ${payload.length - offset} bytes`);
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (!readFileSync(target).equals(payload)) throw new Error('direct fork log did not retain the copied envelopes');
    const readBack = readFactLines(target, { afterSeq });
    if (readBack.length !== lines.length) throw new Error('direct fork log did not retain every copied fact');
    for (let index = 0; index < lines.length; index += 1) {
      const expected = lines[index]!;
      const actual = readBack[index]!;
      if (actual.at !== expected.at || actual.seq !== expected.seq || actual.fact.type !== expected.fact.type) {
        throw new Error('direct fork changed an envelope timestamp, sequence or fact type');
      }
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The write error is the one worth reporting.
      }
    }
    if (!created) {
      throw new Error(`direct fork could not create a new log: ${errorText(error)}`, { cause: error });
    }
    try {
      await unlink(target);
    } catch (cleanup) {
      if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AggregateError([error, cleanup], 'direct fork failed and the new log could not be removed');
      }
    }
    throw error;
  }
}

function serializeLine(line: FactLine): string {
  return `${JSON.stringify({ v: line.v, seq: line.seq, at: line.at, fact: line.fact })}\n`;
}

async function resolveAuthority(
  resolveWorkspace: (root: string, identity?: Workspace) => Workspace | Promise<Workspace>,
  storedRoot: string,
  identity: Workspace | undefined,
): Promise<Workspace> {
  const workspace = await resolveWorkspace(storedRoot, identity);
  if (!isWorkspaceGrant(workspace)) throw new Error('direct fork resolver did not return a workspace grant');
  if (identity) {
    if (identity.root !== storedRoot || !sameWorkspace(workspace, identity)) {
      throw new Error('current workspace grant does not match the stored/requested identity');
    }
  } else if (workspace.target !== 'local' || path.resolve(workspace.root) !== path.resolve(storedRoot)) {
    // A path-only record has no endpoint or access to keep. Do not relabel it as SSH.
    throw new Error('path-only direct Session requires a matching current local workspace grant');
  }
  const root = workspace.target === 'local' ? path.resolve(workspace.root) : workspace.root;
  return { root, target: workspace.target, access: workspace.access };
}

function storedIdentity(fact: SessionStartedFact): Workspace | undefined {
  const record = fact as SessionStartedFact & { readonly workspaceIdentity?: unknown };
  if (!('workspaceIdentity' in record) || record.workspaceIdentity === undefined) return undefined;
  if (!isWorkspaceGrant(record.workspaceIdentity)) {
    throw new Error('direct fork stored workspace identity is not a grant');
  }
  return {
    root: record.workspaceIdentity.root,
    target: record.workspaceIdentity.target,
    access: record.workspaceIdentity.access,
  };
}

function isWorkspaceGrant(value: unknown): value is Workspace {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const grant = value as Workspace;
  return (
    typeof grant.root === 'string' &&
    grant.root.length > 0 &&
    typeof grant.target === 'string' &&
    grant.target.length > 0 &&
    (grant.access === 'read' || grant.access === 'read_write')
  );
}

/** Local roots compare by resolved path. Any other target must match the endpoint string. */
function sameWorkspace(left: Workspace, right: Workspace): boolean {
  return (
    left.access === right.access &&
    left.target === right.target &&
    (left.target === 'local' ? path.resolve(left.root) === path.resolve(right.root) : left.root === right.root)
  );
}

function sameExactGrant(left: Workspace | undefined, right: Workspace | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.root === right.root &&
    left.target === right.target &&
    left.access === right.access
  );
}

function workspaceIdentityOf(fact: Fact): Workspace | undefined {
  if (fact.type !== 'session_started') return undefined;
  const identity = (fact as SessionStartedFact & { readonly workspaceIdentity?: unknown }).workspaceIdentity;
  return isWorkspaceGrant(identity)
    ? { root: identity.root, target: identity.target, access: identity.access }
    : undefined;
}

function validateBinding(binding: DirectBinding | undefined): void {
  if (
    binding !== undefined &&
    (typeof binding.client !== 'string' ||
      !binding.client.trim() ||
      typeof binding.id !== 'string' ||
      !binding.id.trim())
  ) {
    throw new Error('direct Session binding requires nonempty client and id');
  }
}

function provenanceOf(fact: Fact): string | undefined {
  if (fact.type !== 'session_started') return undefined;
  const started = fact as ForkedStart;
  return typeof started.forkedFrom === 'string' && started.forkedFrom.length > 0 ? started.forkedFrom : undefined;
}

function validateExpectedBinding(stored: DirectBinding | undefined, expected: DirectBinding | undefined): void {
  validateBinding(stored);
  if (expected && (!stored || expected.client !== stored.client || expected.id !== stored.id)) {
    throw new Error('direct Session binding does not match the expected client owner');
  }
}

function requireDirectId(id: string): void {
  if (typeof id !== 'string' || !DIRECT_ID.test(id)) {
    throw new Error('expected an exact direct conv_<uuid> Session ID');
  }
}

function logPath(directory: string, id: string): string {
  requireDirectId(id);
  return path.join(directory, `${id}.jsonl`);
}

function newDirectId(): string {
  const id = `conv_${randomUUID()}`;
  requireDirectId(id);
  return id;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
