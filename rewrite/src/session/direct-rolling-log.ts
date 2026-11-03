/** One logical Session, one writable physical head, and a verified accepted lineage. */
import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { FactLine, SessionStartedFact } from './facts.js';
import { createLog, openLog, readFactLinesStamped, type ConversationLog, type StampedLogRead } from './log.js';
import { parseDirectSessionRotation, type DirectSessionRotationFact } from './direct-session-rotation.js';

const DIRECT_ID = /^conv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Dedicated metadata directory; its prefix also passes the CLI's name-only preflight. */
export const DIRECT_LOCK_DIRECTORY = 'conv_locks';
export type DirectLogBoundary = { readonly sessionId: string; readonly seq: number };
export type DirectLogSegment = {
  readonly sessionId: string;
  readonly path: string;
  readonly afterSeq: number;
  readonly throughSeq: number;
  /** The parse of this file, so the writer can continue it without reading it again. */
  readonly read?: StampedLogRead;
};
export type DirectLogLineage = {
  readonly logicalSessionId: string;
  /** Physical file containing the last accepted fact at the requested cut. */
  readonly sessionId: string;
  readonly path: string;
  readonly metadata: SessionStartedFact;
  readonly entries: readonly FactLine[];
  readonly segments: readonly DirectLogSegment[];
};
/** What a live writer already knows about its accepted log, so callers need no parse. */
export type DirectLogSummary = {
  readonly logicalSessionId: string;
  /** Physical file containing the last accepted fact at the requested cut. */
  readonly path: string;
  readonly metadata: SessionStartedFact;
  readonly first: FactLine;
  readonly last: FactLine;
};
export interface DirectRollingLog extends ConversationLog {
  /** Read-only acceptance boundary; app preparation cannot append or rotate it. */
  head(): DirectLogBoundary;
  /** Accepted-history facts from memory, optionally cut at an accepted seq. Undefined before the first fact. */
  summary(throughSeq?: number): DirectLogSummary | undefined;
}

/** Exact logs and the one reserved lock directory; never read foreign data. */
export function directLogNames(directory: string): readonly string[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  for (const name of names) {
    if (name === DIRECT_LOCK_DIRECTORY) {
      if (!lstatSync(join(directory, name)).isDirectory())
        throw new Error('direct Session lock path is not a directory');
      continue;
    }
    if (!name.endsWith('.jsonl') || !DIRECT_ID.test(name.slice(0, -6)))
      throw new Error(`refusing direct conversations directory with foreign entry ${JSON.stringify(name)}`);
    if (!lstatSync(join(directory, name)).isFile()) throw new Error(`direct log is not a regular file: ${name}`);
  }
  return names.filter((name) => name !== DIRECT_LOCK_DIRECTORY);
}

/** Safe physical filename; neither a stored header nor a caller may escape the namespace. */
export function directLogPath(directory: string, id: string): string {
  if (!DIRECT_ID.test(id)) throw new Error('expected an exact direct conv_<uuid> Session ID');
  return join(directory, `${id}.jsonl`);
}

type Header =
  | { readonly type: 'session_started'; readonly id: string; readonly workspace: string }
  | DirectSessionRotationFact;
// Validate the metadata consumed by catalogue/CLI callers before exposing a
// lineage. Parsing is a check only: readFactLines retains the original fact.
const startedHeaderSchema = z.object({
  type: z.literal('session_started'),
  id: z.string(),
  workspace: z.string(),
  model: z.object({ provider: z.string(), model: z.string() }),
  profile: z.object({ id: z.string(), version: z.string(), digest: z.string() }),
  appVersion: z.string(),
});

type Discovery = {
  readonly headers: ReadonlyMap<string, Header>;
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly errors: ReadonlyMap<string, Error>;
};

/** Report the physical path, never repair bytes or hide a requested read failure. */
function reportUnreadable(path: string, error: unknown): void {
  console.warn(`Skipping unreadable direct log ${path}: ${error instanceof Error ? error.message : String(error)}`);
}

/** First read is enough for every real header (a few hundred bytes). Grow only
 * when that chunk has no newline, and stop at 1 MiB. No newline by then is the
 * torn-header case: skip the file instead of reading the rest of it. A first
 * line longer than 1 MiB is treated the same way. */
const HEADER_CHUNK_BYTES = 64 * 1024;
const HEADER_CAP_BYTES = 1024 * 1024;

/** Bytes before the first newline, or null when the file has none within the cap. */
export function readDirectLogHeaderLine(path: string): Buffer | null {
  const fd = openSync(path, 'r');
  try {
    const parts: Buffer[] = [];
    let position = 0;
    let chunkBytes = HEADER_CHUNK_BYTES;
    while (position < HEADER_CAP_BYTES) {
      const want = Math.min(chunkBytes, HEADER_CAP_BYTES - position);
      const chunk = Buffer.alloc(want);
      const n = readSync(fd, chunk, 0, want, position);
      if (n <= 0) return null;
      const slice = chunk.subarray(0, n);
      const end = slice.indexOf(0x0a);
      if (end >= 0) {
        parts.push(slice.subarray(0, end));
        return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
      }
      parts.push(slice);
      position += n;
      if (n < want) return null;
      chunkBytes = Math.min(chunkBytes * 2, HEADER_CAP_BYTES);
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/** One namespace check and header scan per read/catalogue. Unrelated bad files
 * cannot deny healthy Sessions; required bad segments still fail closed. */
export function discoverDirectLogs(directory: string): Discovery {
  const headers = new Map<string, Header>();
  const children = new Map<string, string[]>();
  const errors = new Map<string, Error>();
  // Namespace/authority failures stay global, outside the per-file catch.
  for (const name of directLogNames(directory).slice().sort()) {
    const physicalId = name.slice(0, -6);
    const path = directLogPath(directory, physicalId);
    try {
      const bytes = readDirectLogHeaderLine(path);
      if (bytes === null) continue; // Unaccepted creation/torn-header artifact.
      const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as {
        fact?: { type?: unknown; id?: unknown; predecessor?: { sessionId?: unknown } };
      } | null;
      const fact = raw?.fact;
      // Retain a readable predecessor link BEFORE validating the rotation. A
      // malformed related segment must not silently shorten accepted history.
      const predecessor = fact?.type === 'session_rotated' ? fact.predecessor?.sessionId : undefined;
      if (typeof predecessor === 'string' && DIRECT_ID.test(predecessor)) {
        const siblings = children.get(predecessor) ?? [];
        siblings.push(physicalId);
        children.set(predecessor, siblings);
      }
      let header: Header;
      if (fact?.type === 'session_rotated') header = parseDirectSessionRotation(fact);
      else if (fact?.type === 'session_started') {
        const started = startedHeaderSchema.parse(fact);
        header = { type: 'session_started', id: started.id, workspace: started.workspace };
      } else throw new Error('physical log must begin with session_started or session_rotated');
      if ((header.type === 'session_started' ? header.id : header.sessionId) !== physicalId)
        throw new Error('physical header does not match filename');
      headers.set(physicalId, header);
    } catch (cause) {
      const error = new Error(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      errors.set(physicalId, error);
      reportUnreadable(path, error);
    }
  }
  return { headers, children, errors };
}

/** Resolve any logical/physical alias to the SAME complete lineage, optionally at
 * an accepted global seq cut. Pure read: torn headers are not successors; cycles,
 * divergent successors and a predecessor appended after rotation are refused.
 * The returned cut retains original metadata and actual envelopes, not fake seq. */
export function readDirectLogLineage(
  directory: string,
  id: string,
  options: { readonly throughSeq?: number } = {},
): DirectLogLineage {
  directory = resolve(directory);
  directLogPath(directory, id);
  const cut = options.throughSeq;
  if (cut !== undefined && (!Number.isSafeInteger(cut) || cut < 1))
    throw new Error('direct lineage cut must be a positive accepted sequence');
  const discovery = discoverDirectLogs(directory);
  if (cut !== undefined) return readLineage(directory, id, discovery, cut);
  // Opening a session reads its lineage several times (resolve, validate, lock, construct).
  // An unchanged log is not parsed again: reuse needs identical file stats and no new successor.
  const key = `${directory}\0${id}`;
  const cached = lineageCache.get(key);
  if (cached && lineageUnchanged(cached.lineage, cached.stats, discovery)) {
    lineageCache.delete(key);
    lineageCache.set(key, cached);
    return cached.lineage;
  }
  const lineage = readLineage(directory, id, discovery, undefined);
  const stats = lineage.segments.map((segment) => fileStamp(segment.path));
  lineageCache.delete(key);
  lineageCache.set(key, { lineage, stats });
  while (lineageCache.size > 2) lineageCache.delete(lineageCache.keys().next().value!);
  return lineage;
}

const lineageCache = new Map<string, { lineage: DirectLogLineage; stats: readonly string[] }>();
const fileStamp = (path: string): string => {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
};
function lineageUnchanged(lineage: DirectLogLineage, stats: readonly string[], discovery: Discovery): boolean {
  if (lineage.segments.some((segment, i) => fileStamp(segment.path) !== stats[i])) return false;
  const head = lineage.segments.at(-1)!;
  return (discovery.children.get(head.sessionId) ?? []).length === 0;
}

/** Reuse one discovery snapshot for catalogue aliases, with full fact validation
 * at the actual predecessor seq boundary (never infer or rebase sequence). */
function readLineage(directory: string, id: string, discovery: Discovery, cut?: number): DirectLogLineage {
  const { headers, children, errors } = discovery;
  const requireHeader = (physicalId: string): Header => {
    const error = errors.get(physicalId);
    if (error) throw error;
    const header = headers.get(physicalId);
    if (!header) throw new Error(`direct log ${physicalId} has no accepted first line`);
    return header;
  };
  let rootId = id;
  const ancestors = new Set<string>();
  while (true) {
    if (ancestors.has(rootId)) throw new Error('cycle in direct Session log lineage');
    ancestors.add(rootId);
    const header = requireHeader(rootId);
    if (header.type === 'session_started') break;
    rootId = header.predecessor.sessionId;
  }
  const entries: FactLine[] = [];
  const segments: DirectLogSegment[] = [];
  const visited = new Set<string>();
  let physicalId = rootId;
  let afterSeq = 0;
  while (true) {
    if (visited.has(physicalId)) throw new Error('cycle in direct Session log lineage');
    visited.add(physicalId);
    const header = requireHeader(physicalId);
    if (header.type === 'session_rotated') {
      if (
        header.logicalSessionId !== rootId ||
        header.predecessor.sessionId !== segments.at(-1)?.sessionId ||
        header.predecessor.throughSeq !== afterSeq
      )
        throw new Error(`direct log ${physicalId} does not continue the accepted predecessor boundary`);
    }
    const path = directLogPath(directory, physicalId);
    const read = readFactLinesStamped(path, { afterSeq, prefix: entries });
    const accepted = read.entries;
    if (!accepted.length) throw new Error(`direct log ${physicalId} has no accepted first line`);
    if (accepted.slice(1).some((line) => line.fact.type === 'session_rotated' || line.fact.type === 'session_started'))
      throw new Error(`direct log ${physicalId} contains an interior physical header`);
    const throughSeq = accepted.at(-1)!.seq;
    for (const entry of accepted) entries.push(entry);
    segments.push({ sessionId: physicalId, path, afterSeq, throughSeq, read });
    afterSeq = throughSeq;
    const successors = children.get(physicalId) ?? [];
    if (successors.length > 1) throw new Error(`direct log ${physicalId} has divergent accepted successors`);
    if (!successors.length) break;
    physicalId = successors[0]!;
  }
  if (!visited.has(id)) throw new Error(`direct log ${id} is not in its declared logical lineage`);
  const metadata = entries[0]!.fact;
  if (metadata.type !== 'session_started' || metadata.id !== rootId)
    throw new Error('direct lineage has invalid logical Session metadata');
  if (cut !== undefined && cut > afterSeq) throw new Error('direct lineage cut exceeds accepted history');
  const selected = cut === undefined ? entries : entries.filter((entry) => entry.seq <= cut);
  const lastSeq = selected.at(-1)!.seq;
  const selectedSegments = segments.filter((segment) => segment.afterSeq < lastSeq);
  const head = selectedSegments.at(-1)!;
  return {
    logicalSessionId: rootId,
    sessionId: head.sessionId,
    path: head.path,
    metadata,
    entries: selected,
    segments: selectedSegments,
  };
}

/** Same directory after resolve, then realpath when both exist. */
function sameWorkspacePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  if (resolvedLeft === resolvedRight) return true;
  try {
    return realpathSync(resolvedLeft) === realpathSync(resolvedRight);
  } catch {
    return false;
  }
}

/** Walk headers only. A rotated file's workspace lives on its session_started root. */
function startedWorkspace(discovery: Discovery, id: string): string | undefined {
  const seen = new Set<string>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const header = discovery.headers.get(current);
    if (!header) return undefined;
    if (header.type === 'session_started') return header.workspace;
    current = header.predecessor.sessionId;
  }
  return undefined;
}

/** Catalogue each accepted logical lineage once, reporting/skipping unreadable
 * lineages. Empty/torn headers remain unaccepted artifacts, not Sessions.
 * `workspace`, when set, skips other projects before their bodies are read.
 * Explicit opens still reject corrupt targets and required ancestors/successors. */
export function readDirectLogLineages(
  directory: string,
  options: { readonly workspace?: string } = {},
): readonly DirectLogLineage[] {
  directory = resolve(directory);
  const discovery = discoverDirectLogs(directory);
  const seen = new Set<string>();
  const result: DirectLogLineage[] = [];
  for (const id of discovery.headers.keys()) {
    if (seen.has(id)) continue;
    if (options.workspace !== undefined) {
      const workspace = startedWorkspace(discovery, id);
      if (workspace !== undefined && !sameWorkspacePath(workspace, options.workspace)) continue;
    }
    try {
      const lineage = readLineage(directory, id, discovery);
      for (const segment of lineage.segments) seen.add(segment.sessionId);
      result.push(lineage);
    } catch (error) {
      // Header errors were already reported by discovery, including bad ancestors.
      if (![...discovery.errors.values()].includes(error as Error))
        reportUnreadable(directLogPath(directory, id), error);
    }
  }
  return result.sort((left, right) => left.logicalSessionId.localeCompare(right.logicalSessionId));
}

/** Own exactly one writable physical head. Rotation accepts/fsyncs the complete
 * leading-header batch on an unused file before swapping writers; predecessor
 * bytes stay immutable. Any failed append poisons this authority, with no retry. */
export function createDirectRollingLog(
  directory: string,
  logicalSessionId: string,
  lineage?: DirectLogLineage,
): DirectRollingLog {
  directory = resolve(directory);
  directLogPath(directory, logicalSessionId);
  if (lineage && lineage.logicalSessionId !== logicalSessionId) throw new Error('mismatched direct log lineage');
  const segment = lineage?.segments.at(-1);
  if (segment && lineage!.entries.at(-1)?.seq !== segment.throughSeq)
    throw new Error('cannot acquire a writer from a historical lineage cut');
  const acceptedEntries = [...(lineage?.entries ?? [])];
  let current = segment
    ? openLog(segment.path, {
        afterSeq: segment.afterSeq,
        prefix: acceptedEntries.filter((entry) => entry.seq <= segment.afterSeq),
        ...(segment.read ? { parsed: segment.read } : {}),
      })
    : createLog(directory, logicalSessionId);
  let head: DirectLogBoundary = {
    sessionId: segment?.sessionId ?? logicalSessionId,
    seq: lineage?.entries.at(-1)?.seq ?? 0,
  };
  // Where each physical file starts, so a cut can name the file that holds its last fact.
  const physical: { path: string; afterSeq: number }[] = lineage
    ? lineage.segments.map((entry) => ({ path: entry.path, afterSeq: entry.afterSeq }))
    : [{ path: current.path, afterSeq: 0 }];
  let dead = false;
  let closed = false;
  return {
    get path() {
      return current.path;
    },
    head: () => ({ ...head }),
    summary(throughSeq) {
      const first = acceptedEntries[0];
      if (!first) return undefined;
      if (first.fact.type !== 'session_started') throw new Error('direct lineage has invalid logical Session metadata');
      if (throughSeq !== undefined && (!Number.isSafeInteger(throughSeq) || throughSeq < 1))
        throw new Error('direct lineage cut must be a positive accepted sequence');
      if (throughSeq !== undefined && throughSeq > acceptedEntries.at(-1)!.seq)
        throw new Error('direct lineage cut exceeds accepted history');
      let low = 0;
      let high = acceptedEntries.length - 1;
      if (throughSeq !== undefined)
        while (low < high) {
          const mid = (low + high + 1) >> 1;
          if (acceptedEntries[mid]!.seq <= throughSeq) low = mid;
          else high = mid - 1;
        }
      else low = high;
      const last = acceptedEntries[low]!;
      let file = physical[0]!;
      for (const entry of physical) if (entry.afterSeq < last.seq) file = entry;
      return { logicalSessionId, path: file.path, metadata: first.fact, first, last };
    },
    append(facts) {
      if (dead || closed) throw new Error('direct rolling log is closed or unusable after a write failure');
      if (!facts.length) return [];
      let successor: ConversationLog | undefined;
      try {
        const first = facts[0]!;
        if (facts.slice(1).some((fact) => fact.type === 'session_rotated'))
          throw new Error('physical rotation must be the first fact of its acceptance batch');
        if (first.type !== 'session_rotated') {
          const accepted = current.append(facts);
          for (const entry of accepted) acceptedEntries.push(entry);
          head = { ...head, seq: accepted.at(-1)!.seq };
          return accepted;
        }
        const rotation = parseDirectSessionRotation(first);
        if (
          rotation.logicalSessionId !== logicalSessionId ||
          rotation.predecessor.sessionId !== head.sessionId ||
          rotation.predecessor.throughSeq !== head.seq ||
          rotation.sessionId === head.sessionId ||
          rotation.sessionId === logicalSessionId
        )
          throw new Error('rotation does not match the current physical acceptance boundary');
        directLogNames(directory);
        successor = createLog(directory, rotation.sessionId, { afterSeq: head.seq, prefix: acceptedEntries });
        const accepted = successor.append(facts);
        for (const entry of accepted) acceptedEntries.push(entry);
        const predecessor = current;
        const successorPath = successor.path;
        current = successor;
        successor = undefined;
        physical.push({ path: successorPath, afterSeq: rotation.predecessor.throughSeq });
        head = { sessionId: rotation.sessionId, seq: accepted.at(-1)!.seq };
        predecessor.close();
        return accepted;
      } catch (error) {
        dead = true;
        try {
          successor?.close();
        } catch {
          // Preserve the acceptance failure, never retry or remove accepted bytes.
        }
        throw error;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      current.close();
    },
  };
}

/** Header walk only: the file that starts a session and the file that currently ends it. */
export function directLogicalEnds(directory: string): ReadonlyMap<string, { rootPath: string; headPath: string }> {
  directory = resolve(directory);
  const { headers, children } = discoverDirectLogs(directory);
  const ends = new Map<string, { rootPath: string; headPath: string }>();
  for (const id of headers.keys()) {
    const seen = new Set<string>();
    let rootId = id;
    while (headers.get(rootId)?.type === 'session_rotated') {
      if (seen.has(rootId)) break;
      seen.add(rootId);
      const predecessor = headers.get(rootId);
      if (predecessor?.type !== 'session_rotated' || !headers.has(predecessor.predecessor.sessionId)) break;
      rootId = predecessor.predecessor.sessionId;
    }
    if (headers.get(rootId)?.type !== 'session_started' || ends.has(rootId)) continue;
    let headId = rootId;
    const walked = new Set<string>();
    while (!walked.has(headId)) {
      walked.add(headId);
      const next = children.get(headId) ?? [];
      if (next.length !== 1 || !headers.has(next[0]!)) break;
      headId = next[0]!;
    }
    ends.set(rootId, { rootPath: directLogPath(directory, rootId), headPath: directLogPath(directory, headId) });
  }
  return ends;
}
