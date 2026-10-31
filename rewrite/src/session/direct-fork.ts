/**
 * Copy one authorized direct conversation into a new log in the same
 * conversations-next directory. Copied envelopes keep their original `at`
 * and every accepted fact, including goal, queue, memory, branch and task
 * facts. ConversationLog.append is not used for those lines because it
 * stamps a new clock. An open turn's replay recovery is appended only on
 * the copy. The source is never opened for write, and no live runtime,
 * task or tool is started.
 *
 * Requires the lead fact/log contracts: readFactLines, the widened Fact
 * union, and replay that understands that vocabulary.
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
  /** The store's resolver. The resolved root must match the stored path. */
  readonly resolveWorkspace: (root: string) => Workspace | Promise<Workspace>;
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

type ForkedStart = SessionStartedFact & { readonly forkedFrom: string };

/**
 * Throws when the source is missing, unauthorized, foreign, or not a valid
 * replay. Those failures happen before the new log is created. A failed
 * write is deleted. Success returns the new id and does not modify the source.
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
  const sourceLines = readFactLines(logPath(directory, sourceId));
  const metadata = sessionMetadata(sourceId, sourceLines.map((line) => line.fact));
  validateExpectedBinding(metadata.binding, expected);
  // Reject a log this Session cannot replay before any new file exists.
  // Clone first so projection cannot alias the envelopes we copy.
  replay(sourceLines.map((line) => structuredClone(line.fact)));
  const workspace = await resolveAuthority(request.resolveWorkspace, metadata.workspace);
  const id = newDirectId();
  const copied = sourceLines.map((line) => ({
    v: line.v,
    seq: line.seq,
    at: line.at,
    fact: retargetFact(line.fact, sourceId, id, workspace.root),
  }));
  const projected = replay(copied.map((line) => line.fact));
  const stampedAt = new Date().toISOString();
  const recovery = projected.recoveryFacts.map((fact, index) => ({
    v: LOG_FORMAT_VERSION,
    seq: copied.length + index + 1,
    at: stampedAt,
    fact,
  }));
  const lines = [...copied, ...recovery];
  const stable = replay(lines.map((line) => line.fact));
  if (stable.recoveryFacts.length !== 0) throw new Error('direct fork replay did not settle');
  await writeFork(directory, sourceId, id, lines);

  const started = lines[0]?.fact;
  if (started?.type !== 'session_started') throw new Error('direct fork lost its session_started fact');
  return {
    sourceId,
    id,
    workspace,
    model: structuredClone(started.model),
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
 * New conversation id and workspace authority. Task ownership follows that id
 * so replay does not treat the copy as another Session. Memory sourceSessionId
 * stays the recorded provenance and is not rewritten. forkedFrom is the
 * immediate source, on the single session_started fact.
 */
function retargetFact(fact: Fact, sourceId: string, id: string, workspace: string): Fact {
  const copy = structuredClone(fact);
  if (copy.type === 'session_started') {
    if (copy.id !== sourceId) {
      throw new Error(`direct Session ${sourceId} has invalid or mismatched session_started metadata`);
    }
    const started: ForkedStart = { ...copy, id, workspace, forkedFrom: sourceId };
    return started;
  }
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

async function writeFork(directory: string, sourceId: string, id: string, lines: readonly FactLine[]): Promise<void> {
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
    const readBack = readFactLines(target);
    if (readBack.length !== lines.length) throw new Error('direct fork log did not retain every copied fact');
    for (let index = 0; index < lines.length; index += 1) {
      const expected = lines[index]!;
      const actual = readBack[index]!;
      if (actual.at !== expected.at || actual.seq !== expected.seq || actual.fact.type !== expected.fact.type) {
        throw new Error('direct fork changed an envelope timestamp, sequence or fact type');
      }
    }
    const started = readBack[0]?.fact;
    if (started?.type !== 'session_started' || started.id !== id || provenanceOf(started) !== sourceId) {
      throw new Error('direct fork lost its provenance');
    }
    if (replay(readBack.map((line) => line.fact)).recoveryFacts.length !== 0) {
      throw new Error('direct fork replay did not settle');
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
  resolveWorkspace: (root: string) => Workspace | Promise<Workspace>,
  storedRoot: string,
): Promise<Workspace> {
  const workspace = await resolveWorkspace(storedRoot);
  if (typeof workspace?.root !== 'string' || path.resolve(workspace.root) !== path.resolve(storedRoot)) {
    throw new Error('resolved workspace does not match the stored root');
  }
  return { ...workspace, root: path.resolve(workspace.root) };
}

function sessionMetadata(id: string, facts: readonly Fact[]): SessionStartedFact {
  const first = facts[0];
  if (
    first?.type !== 'session_started' ||
    first.id !== id ||
    typeof first.workspace !== 'string' ||
    first.workspace.length === 0 ||
    facts.slice(1).some((fact) => fact.type === 'session_started')
  ) {
    throw new Error(`direct Session ${id} has invalid or mismatched session_started metadata`);
  }
  return first;
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
