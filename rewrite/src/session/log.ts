/**
 * The conversation log file. One writer, one JSONL line per fact.
 *
 * `append` writes the whole buffer in one operation, finishing short writes,
 * and fsyncs unless every fact is `text_delta`. If it throws, the log is dead:
 * no later append may run, because a short write leaves an unterminated line
 * that another write would glue onto.
 *
 * `readFacts` tolerates only an unterminated final line. An unknown version, an
 * unknown fact type, a bad interior line or a seq gap throws.
 *
 * A fact is one *terminated* line. A final line without its newline is torn,
 * even when its bytes happen to parse: `readFacts` ignores it, and the next
 * non-empty append truncates it first. Opening alone changes no bytes. That is
 * what keeps a killed process's half-line from becoming history or from
 * swallowing the next fact.
 */

import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { isKnownDirectFactType, validateFact } from './log-facts.js';
import { LOG_FORMAT_VERSION, type Fact, type FactLine } from './facts.js';

export interface ConversationLog {
  readonly path: string;
  /** Exact serialized entries, returned only after the write and required fsync succeed. */
  append(facts: readonly Fact[]): readonly FactLine[];
  close(): void;
}

const NEWLINE = 0x0a;

type ParsedLog = {
  readonly entries: readonly FactLine[];
  readonly lastSeq: number;
  /** Byte length of the terminated lines; anything after it is a torn tail. */
  readonly complete: number;
};

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Parses every terminated line. A last line without `\n` is not a fact and is
 * only reported through `complete` and `lastSeq`, so callers can truncate it.
 */
function parseLog(data: Buffer, path: string): ParsedLog {
  if (data.length === 0) return { entries: [], lastSeq: 0, complete: 0 };

  const complete = data.lastIndexOf(NEWLINE) + 1;
  if (complete === 0) return { entries: [], lastSeq: 0, complete: 0 };

  let text: string;
  try {
    text = UTF8.decode(data.subarray(0, complete));
  } catch (error) {
    throw new Error(`${path}: invalid UTF-8 in log: ${errorMessage(error)}`, { cause: error });
  }

  const lines = text.split('\n');
  // The empty string after the final newline.
  lines.pop();

  const entries: FactLine[] = [];
  let lastSeq = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineNumber = index + 1;
    const expectedSeq = lastSeq + 1;
    const where = `${path}:${lineNumber}`;

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      throw new Error(`${where}: invalid JSON: ${errorMessage(error)}`, { cause: error });
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${where}: log line is not an object`);
    }

    const record = entry as Record<string, unknown>;
    const version = record['v'];
    if (version !== LOG_FORMAT_VERSION) {
      throw new Error(`${where}: unsupported log version ${String(version)}`);
    }

    const seq = record['seq'];
    if (typeof seq !== 'number' || !Number.isInteger(seq)) {
      throw new Error(`${where}: log sequence is not an integer`);
    }
    if (seq !== expectedSeq) {
      throw new Error(`${where}: sequence gap: expected ${expectedSeq}, found ${seq}`);
    }

    if (typeof record['at'] !== 'string') {
      throw new Error(`${where}: log timestamp is not a string`);
    }

    const fact = record['fact'];
    if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) {
      throw new Error(`${where}: log fact is not an object`);
    }
    const type = (fact as Record<string, unknown>)['type'];
    if (typeof type !== 'string' || !isKnownDirectFactType(type)) {
      throw new Error(`${where}: unknown fact type ${JSON.stringify(String(type))}`);
    }

    try {
      validateFact(fact as Record<string, unknown>, where);
    } catch (error) {
      throw new Error(`${where}: invalid ${type}: ${errorMessage(error)}`, { cause: error });
    }
    entries.push(entry as FactLine);
    lastSeq = seq;
  }

  return { entries, lastSeq, complete };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createConversationLog(path: string, fd: number, firstSeq: number, tornFrom?: number): ConversationLog {
  let sequence = firstSeq;
  let handle: number | null = fd;
  let dead = false;
  let pendingTruncate = tornFrom;

  return {
    path,

    append(facts: readonly Fact[]): readonly FactLine[] {
      if (dead) {
        throw new Error(`conversation log ${path} is unusable after an earlier write failure`);
      }
      if (handle === null) {
        throw new Error(`conversation log ${path} is closed`);
      }
      if (facts.length === 0) return [];

      const fd = handle;

      try {
        const lines = facts.map((fact) => {
          const line: FactLine = {
            v: LOG_FORMAT_VERSION,
            seq: sequence,
            at: new Date().toISOString(),
            fact,
          };
          sequence += 1;
          return `${JSON.stringify(line)}\n`;
        });
        // Decode the actual bytes once: JSON serialization may omit undefined
        // fields or invoke provider payload toJSON methods. Observers must receive
        // the persisted values, not mutable caller objects or regenerated clocks.
        const entries = lines.map((line) => JSON.parse(line) as FactLine);
        const buffer = Buffer.from(lines.join(''), 'utf8');
        if (pendingTruncate !== undefined) {
          ftruncateSync(fd, pendingTruncate);
          pendingTruncate = undefined;
        }
        let offset = 0;
        while (offset < buffer.length) {
          const written = writeSync(fd, buffer, offset, buffer.length - offset);
          if (written <= 0) {
            throw new Error(`short write: wrote ${written} of ${buffer.length - offset} bytes`);
          }
          offset += written;
        }
        // Deltas may be lost on power failure; every other fact may not.
        if (!facts.every((fact) => fact.type === 'text_delta')) {
          fsyncSync(fd);
        }
        return entries;
      } catch (error) {
        dead = true;
        handle = null;
        try {
          closeSync(fd);
        } catch {
          // The write failure is the one worth reporting.
        }
        throw new Error(`conversation log ${path} write failed: ${errorMessage(error)}`, { cause: error });
      }
    },

    close(): void {
      if (handle === null) return;
      const fd = handle;
      handle = null;
      closeSync(fd);
    },
  };
}

/** Opens `<dir>/<id>.jsonl` with 'wx'. The directory refusal (D9) happens in app before this. */
export function createLog(dir: string, id: string): ConversationLog {
  const path = join(dir, `${id}.jsonl`);
  return createConversationLog(path, openSync(path, 'wx'), 1);
}

/** Changes no bytes: continues the seq, and leaves a torn final line for the next append to remove. */
export function openLog(path: string): ConversationLog {
  const data = readFileSync(path);
  const { lastSeq, complete } = parseLog(data, path);
  // Append mode: after the truncate, writes land at the new end without a position.
  return createConversationLog(path, openSync(path, 'a'), lastSeq + 1, complete !== data.length ? complete : undefined);
}

/** Pure read of the exact accepted envelopes; ignores only an unterminated final line. */
export function readFactLines(path: string): readonly FactLine[] {
  return parseLog(readFileSync(path), path).entries;
}

/** Pure fact projection of the same validated entries; never writes. */
export function readFacts(path: string): readonly Fact[] {
  return readFactLines(path).map((entry) => entry.fact);
}
