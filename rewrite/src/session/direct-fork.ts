/**
 * Copy one authorized direct conversation into a new log in the same
 * conversations-next directory. The source is only read. Replay recovery for
 * an open turn is appended to the copy, so the fork does not resume live work
 * or re-run an unobserved tool effect. No runtime is constructed; the host
 * opens the returned id through the direct store.
 */
import { randomUUID } from 'node:crypto';
import { lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ModelRef } from '../model/index.js';
import type { Workspace } from '../tools/index.js';
import type { DirectBinding } from './facade-types.js';
import type { Fact, SessionStartedFact } from './facts.js';
import { createLog, readFacts, type ConversationLog } from './log.js';
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
  /** Recovery facts written on the fork only. Zero when the source turn was already closed. */
  readonly materializedRecovery: number;
};

type SettledFork = {
  readonly status: 'idle' | 'interrupted';
  readonly started: SessionStartedFact;
};

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
  const sourceFacts = readFacts(logPath(directory, sourceId));
  const metadata = sessionMetadata(sourceId, sourceFacts);
  validateExpectedBinding(metadata.binding, expected);
  const projected = replay(sourceFacts);
  const workspace = await resolveAuthority(request.resolveWorkspace, metadata.workspace);
  const id = newDirectId();
  const facts = copiedFacts(metadata, id, workspace.root, sourceFacts, projected.recoveryFacts);
  const settled = await writeFork(directory, sourceId, id, facts);

  return {
    sourceId,
    id,
    workspace,
    model: structuredClone(settled.started.model),
    ...(settled.started.binding ? { binding: structuredClone(settled.started.binding) } : {}),
    status: settled.status,
    materializedRecovery: projected.recoveryFacts.length,
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

function copiedFacts(
  metadata: SessionStartedFact,
  id: string,
  workspace: string,
  source: readonly Fact[],
  recovery: readonly Fact[],
): Fact[] {
  const started: SessionStartedFact = {
    ...structuredClone(metadata),
    type: 'session_started',
    id,
    workspace,
  };
  return [
    started,
    ...source.slice(1).map((fact) => structuredClone(fact)),
    ...recovery.map((fact) => structuredClone(fact)),
  ];
}

async function writeFork(
  directory: string,
  sourceId: string,
  id: string,
  facts: readonly Fact[],
): Promise<SettledFork> {
  const target = logPath(directory, id);
  if (id === sourceId || path.resolve(target) === path.resolve(logPath(directory, sourceId))) {
    throw new Error('direct fork refused to write the source log');
  }
  let log: ConversationLog | undefined;
  let created = false;
  try {
    log = createLog(directory, id);
    created = true;
    log.append(facts);
    log.close();
    const written = readFacts(target);
    if (written.length !== facts.length) throw new Error('direct fork log did not retain every copied fact');
    const started = sessionMetadata(id, written);
    const stable = replay(written);
    if (stable.recoveryFacts.length !== 0) throw new Error('direct fork replay did not settle');
    return { status: stable.status, started };
  } catch (error) {
    if (!created) {
      throw new Error(`direct fork could not create a new log: ${errorText(error)}`, { cause: error });
    }
    try {
      await discardNewLog(log, target);
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'direct fork failed and the new log could not be removed');
    }
    throw error;
  }
}

async function discardNewLog(log: ConversationLog | undefined, target: string): Promise<void> {
  const failures: unknown[] = [];
  try {
    log?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.push(error);
  }
  if (failures.length > 0) throw new AggregateError(failures, 'direct fork could not remove its new log');
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
