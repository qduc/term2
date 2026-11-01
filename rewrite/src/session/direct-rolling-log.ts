/** One logical Session, one writable physical head, and a verified accepted lineage. */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FactLine, SessionStartedFact } from './facts.js';
import { createLog, openLog, readFactLines, type ConversationLog } from './log.js';
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
export interface DirectRollingLog extends ConversationLog {
  /** Read-only acceptance boundary; app preparation cannot append or rotate it. */
  head(): DirectLogBoundary;
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

type Header = { readonly type: 'session_started'; readonly id: string } | DirectSessionRotationFact;

/** Read only a COMPLETE first line for discovery. Full envelope validation follows
 * after the real predecessor boundary is known, never by inferring/rebasing seq. */
function firstHeader(path: string): Header | undefined {
  const bytes = readFileSync(path);
  const end = bytes.indexOf(0x0a);
  if (end < 0) return undefined;
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end))) as {
    fact?: { type?: unknown; id?: unknown };
  };
  if (raw?.fact?.type === 'session_rotated') return parseDirectSessionRotation(raw.fact);
  if (raw?.fact?.type === 'session_started' && typeof raw.fact.id === 'string')
    return { type: 'session_started', id: raw.fact.id };
  throw new Error(`${path}: physical log must begin with session_started or session_rotated`);
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
  const headers = new Map<string, Header>();
  const children = new Map<string, string[]>();
  for (const name of directLogNames(directory)) {
    const physicalId = name.slice(0, -6);
    const header = firstHeader(join(directory, name));
    if (!header) continue;
    if ((header.type === 'session_started' ? header.id : header.sessionId) !== physicalId)
      throw new Error(`${name}: physical header does not match filename`);
    headers.set(physicalId, header);
    if (header.type === 'session_rotated') {
      const siblings = children.get(header.predecessor.sessionId) ?? [];
      siblings.push(physicalId);
      children.set(header.predecessor.sessionId, siblings);
    }
  }
  let rootId = id;
  const ancestors = new Set<string>();
  while (true) {
    if (ancestors.has(rootId)) throw new Error('cycle in direct Session log lineage');
    ancestors.add(rootId);
    const header = headers.get(rootId);
    if (!header) throw new Error(`direct log ${rootId} has no accepted first line`);
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
    const header = headers.get(physicalId)!;
    if (header.type === 'session_rotated') {
      if (
        header.logicalSessionId !== rootId ||
        header.predecessor.sessionId !== segments.at(-1)?.sessionId ||
        header.predecessor.throughSeq !== afterSeq
      )
        throw new Error(`direct log ${physicalId} does not continue the accepted predecessor boundary`);
    }
    const path = directLogPath(directory, physicalId);
    const accepted = readFactLines(path, { afterSeq });
    if (!accepted.length) throw new Error(`direct log ${physicalId} has no accepted first line`);
    if (accepted.slice(1).some((line) => line.fact.type === 'session_rotated' || line.fact.type === 'session_started'))
      throw new Error(`direct log ${physicalId} contains an interior physical header`);
    const throughSeq = accepted.at(-1)!.seq;
    entries.push(...accepted);
    segments.push({ sessionId: physicalId, path, afterSeq, throughSeq });
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

/** Catalogue each accepted logical lineage once. A file with no complete first
 * fact is an unaccepted creation/torn-header artifact, not another Session. */
export function readDirectLogLineages(directory: string): readonly DirectLogLineage[] {
  const seen = new Set<string>();
  const result: DirectLogLineage[] = [];
  for (const name of directLogNames(directory).slice().sort()) {
    const id = name.slice(0, -6);
    if (seen.has(id) || !firstHeader(directLogPath(directory, id))) continue;
    const lineage = readDirectLogLineage(directory, id);
    for (const segment of lineage.segments) seen.add(segment.sessionId);
    result.push(lineage);
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
  let current = segment
    ? openLog(segment.path, { afterSeq: segment.afterSeq })
    : createLog(directory, logicalSessionId);
  let head: DirectLogBoundary = {
    sessionId: segment?.sessionId ?? logicalSessionId,
    seq: lineage?.entries.at(-1)?.seq ?? 0,
  };
  let dead = false;
  let closed = false;
  return {
    get path() {
      return current.path;
    },
    head: () => ({ ...head }),
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
        successor = createLog(directory, rotation.sessionId, { afterSeq: head.seq });
        const accepted = successor.append(facts);
        const predecessor = current;
        current = successor;
        successor = undefined;
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
