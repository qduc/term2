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

import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { LogPayloads } from './log-payloads.js';
import { isKnownDirectFactType, validateFact } from './log-facts.js';
import { LOG_FORMAT_VERSION, type Fact, type FactLine } from './facts.js';

export interface ConversationLog {
  readonly path: string;
  /** Hydrated accepted envelopes, returned only after the write and required fsync succeed. */
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
function continuationSeq(afterSeq: number | undefined): number {
  if (afterSeq === undefined) return 0;
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw new Error('log afterSeq must be a nonnegative safe integer');
  }
  return afterSeq;
}

function parseLog(data: Buffer, path: string, afterSeq = 0, prefix: readonly FactLine[] = []): ParsedLog {
  const payloads = new LogPayloads(prefix);
  if (data.length === 0) return { entries: [], lastSeq: afterSeq, complete: 0 };

  const complete = data.lastIndexOf(NEWLINE) + 1;
  if (complete === 0) return { entries: [], lastSeq: afterSeq, complete: 0 };

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
  let lastSeq = afterSeq;

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
      payloads.decode(seq, fact as Fact, record['refs']);
      validateFact(fact as Record<string, unknown>, where);
    } catch (error) {
      throw new Error(`${where}: invalid ${type}: ${errorMessage(error)}`, { cause: error });
    }
    payloads.accept(seq, fact as Fact);
    entries.push({ v: LOG_FORMAT_VERSION, seq, at: record['at'], fact: fact as Fact });
    lastSeq = seq;
  }

  return { entries, lastSeq, complete };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createConversationLog(
  path: string,
  fd: number,
  firstSeq: number,
  prefix: readonly FactLine[] = [],
  tornFrom?: number,
  timestamp: () => string = () => new Date().toISOString(),
): ConversationLog {
  const payloads = new LogPayloads(prefix);
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
        const entries: FactLine[] = [];
        const lines = facts.map((fact) => {
          // Normalize once, honoring JSON/toJSON just as the old writer did.
          // Projections must never re-enter the durable vocabulary.
          const normalized = JSON.parse(JSON.stringify(fact)) as Fact;
          if (normalized.type === 'turn_ended') delete (normalized as { finalWindow?: unknown }).finalWindow;
          if (normalized.type === 'branch_event' && normalized.fact.type === 'turn_ended')
            delete (normalized.fact as { finalWindow?: unknown }).finalWindow;
          const line: FactLine = {
            v: LOG_FORMAT_VERSION,
            seq: sequence,
            at: timestamp(),
            fact: normalized,
          };
          const compact = payloads.encode(sequence, normalized);
          payloads.accept(sequence, normalized);
          sequence += 1;
          entries.push(line);
          return `${JSON.stringify({ ...line, ...compact })}\n`;
        });
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

/** A parse of one physical log with the file's identity at read time (stat taken before reading). */
export type StampedLogRead = ParsedLog & { readonly size: number; readonly mtimeMs: number };

export type LogContinuationOptions = {
  /** An earlier read of this same file. Used instead of parsing again only while size and mtime still match. */
  readonly parsed?: StampedLogRead;
  /** Predecessor's last accepted seq. The next line must be this value plus one. Default 0. */
  readonly afterSeq?: number;
  /** Accepted predecessor envelopes, required when payload references cross rotation. */
  readonly prefix?: readonly FactLine[];
};

/** Opens `<dir>/<id>.jsonl` with 'wx'. The directory refusal (D9) happens in app before this. */
export function createLog(
  dir: string,
  id: string,
  options: LogContinuationOptions & { readonly timestamp?: () => string } = {},
): ConversationLog {
  const path = join(dir, `${id}.jsonl`);
  return createConversationLog(
    path,
    openSync(path, 'wx'),
    continuationSeq(options.afterSeq) + 1,
    options.prefix,
    undefined,
    options.timestamp,
  );
}

/** Changes no bytes: continues the seq, and leaves a torn final line for the next append to remove. */
export function openLog(path: string, options: LogContinuationOptions = {}): ConversationLog {
  const known = options.parsed;
  let reuse: StampedLogRead | undefined;
  if (known) {
    const stat = statSync(path);
    if (stat.size === known.size && stat.mtimeMs === known.mtimeMs) reuse = known;
  }
  let lastSeq: number, complete: number, entries: readonly FactLine[], size: number;
  if (reuse) ({ lastSeq, complete, entries, size } = reuse);
  else {
    const data = readFileSync(path);
    ({ lastSeq, complete, entries } = parseLog(data, path, continuationSeq(options.afterSeq), options.prefix));
    size = data.length;
  }
  // Append mode: after the truncate, writes land at the new end without a position.
  return createConversationLog(
    path,
    openSync(path, 'a'),
    lastSeq + 1,
    [...(options.prefix ?? []), ...entries],
    complete !== size ? complete : undefined,
  );
}

/** Like readFactLines, keeping what openLog needs to continue the same file without parsing it again. */
export function readFactLinesStamped(path: string, options: LogContinuationOptions = {}): StampedLogRead {
  const stat = statSync(path);
  const data = readFileSync(path);
  const parsed = parseLog(data, path, continuationSeq(options.afterSeq), options.prefix);
  return { ...parsed, size: data.length, mtimeMs: stat.mtimeMs };
}

/**
 * Parses only the bytes from `offset`, a line boundary an earlier read reported as complete. The first line
 * there must carry `afterSeq + 1`. Payload references into earlier lines cannot be resolved without them and
 * throw, so a caller that holds no prefix falls back to a full read. `complete` is the new absolute boundary.
 */
export function readFactLinesFrom(
  path: string,
  offset: number,
  afterSeq: number,
): { readonly entries: readonly FactLine[]; readonly complete: number; readonly lastSeq: number } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const data = Buffer.alloc(Math.max(0, size - offset));
    readSync(fd, data, 0, data.length, offset);
    const parsed = parseLog(data, path, afterSeq, []);
    return { entries: parsed.entries, complete: offset + parsed.complete, lastSeq: parsed.lastSeq };
  } finally {
    closeSync(fd);
  }
}

/** Pure read of accepted envelopes with payload references hydrated; ignores only a torn final line. */
export function readFactLines(path: string, options: LogContinuationOptions = {}): readonly FactLine[] {
  return parseLog(readFileSync(path), path, continuationSeq(options.afterSeq), options.prefix).entries;
}

/** Pure fact projection of the same validated entries; never writes. */
export function readFacts(path: string, options: LogContinuationOptions = {}): readonly Fact[] {
  return readFactLines(path, options).map((entry) => entry.fact);
}
