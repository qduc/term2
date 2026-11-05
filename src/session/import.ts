/** Offline publication of converted native facts; no source decoding or live Session authority. */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Fact } from './facts.js';
import { createLog, readFactLines } from './log.js';
import { directLogNames, directLogPath, readDirectLogLineage } from './rolling-log.js';
import { acquireDirectWriterLock } from './writer-lock.js';
import { replay } from './replay.js';

export type DirectImportOptions = {
  readonly directory: string;
  readonly id: string;
  readonly entries: readonly { readonly at: string; readonly fact: Fact }[];
};
export type DirectImportResult = {
  readonly status: 'published' | 'already-present';
  readonly id: string;
  readonly bytes: number;
  readonly sha256: string;
};

function syncFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Encode, hydrate and replay a complete native stream before exclusively publishing
 * its chosen ID. Exact bytes are idempotent; mismatch, rotation and recovery debt
 * fail closed. Returns byte count/hash only, never transcript or source metadata.
 */
export function importDirectSession({ directory, id, entries }: DirectImportOptions): DirectImportResult {
  directory = resolve(directory);
  const target = directLogPath(directory, id);
  if (dirname(directory) === directory) throw new Error('direct import destination cannot be a filesystem root');
  for (const entry of entries) {
    // Accept canonical UTC instants only, retaining their exact original spelling.
    if (
      typeof entry.at !== 'string' ||
      !Number.isFinite(Date.parse(entry.at)) ||
      new Date(entry.at).toISOString() !== entry.at
    )
      throw new Error('direct import timestamp must be a canonical ISO UTC instant');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error('direct import destination is not a real directory');
  directLogNames(directory);
  const release = acquireDirectWriterLock(target);
  let stage: string | undefined;
  try {
    const names = directLogNames(directory);
    // A sibling stage is outside the strict namespace and on its filesystem.
    stage = mkdtempSync(join(dirname(realpathSync(directory)), '.direct-import-'));
    chmodSync(stage, 0o700);
    let at = '';
    const log = createLog(stage, id, { timestamp: () => at });
    try {
      chmodSync(log.path, 0o600);
      for (const entry of entries) {
        at = entry.at;
        log.append([entry.fact]);
      }
    } finally {
      log.close();
    }
    const hydrated = readFactLines(log.path);
    const facts = hydrated.map((line) => line.fact);
    if (facts[0]?.type !== 'session_started' || facts[0].id !== id)
      throw new Error('direct import requires session_started matching the destination ID');
    if (facts.slice(1).some((fact) => fact.type === 'session_started' || fact.type === 'session_rotated'))
      throw new Error('direct import cannot contain interior or rotated Session headers');
    if (replay(facts).recoveryFacts.length !== 0) throw new Error('direct import has unfinished replay repair debt');
    const bytes = readFileSync(log.path);
    const metadata = { id, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    // Reject successors even if the root bytes themselves are identical (or absent).
    for (const name of names) {
      if (name === `${id}.jsonl`) continue;
      // Match R8 discovery's acceptance boundary: unrelated malformed or torn
      // headers have no trustworthy association and cannot deny a healthy import.
      const data = readFileSync(join(directory, name));
      const end = data.indexOf(0x0a);
      if (end < 0) continue;
      let header: { type?: string; logicalSessionId?: string; predecessor?: { sessionId?: string } } | undefined;
      try {
        header = (
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, end))) as {
            fact?: typeof header;
          } | null
        )?.fact;
      } catch {
        continue;
      }
      if (
        header?.type === 'session_rotated' &&
        (header.logicalSessionId === id || header.predecessor?.sessionId === id)
      )
        throw new Error('direct import target has a rotated successor');
    }
    if (names.includes(`${id}.jsonl`)) {
      const lineage = readDirectLogLineage(directory, id);
      if (lineage.segments.length !== 1 || lineage.logicalSessionId !== id || !readFileSync(target).equals(bytes))
        throw new Error('direct import target differs from staged bytes or is rotated');
      syncFile(target);
      syncFile(directory);
      return { status: 'already-present', ...metadata };
    }
    syncFile(log.path);
    // link is atomic and exclusive: EEXIST never replaces even a late foreign writer.
    linkSync(log.path, target);
    syncFile(directory);
    return { status: 'published', ...metadata };
  } finally {
    try {
      if (stage !== undefined) rmSync(stage, { recursive: true });
    } finally {
      release();
    }
  }
}
