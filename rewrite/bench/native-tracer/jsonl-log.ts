import fs from 'node:fs';
import type { TracerFact, TracerLogEntry, TracerSessionLog } from './session-types.js';

/**
 * Append-only JSONL file. One `append` call is one write plus fsync, so a
 * step's facts land together; a torn final line from a crash is ignored on read.
 */
export class JsonlSessionLog implements TracerSessionLog {
  readonly #path: string;
  #lastSeq: number;

  constructor(path: string) {
    this.#path = path;
    const { entries, validBytes } = readEntries(path);
    // Drop a torn tail now, so the next append does not land after garbage.
    if (fs.existsSync(path) && fs.statSync(path).size > validBytes) fs.truncateSync(path, validBytes);
    this.#lastSeq = entries.at(-1)?.seq ?? 0;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  async append(facts: readonly TracerFact[]): Promise<readonly number[]> {
    const at = new Date().toISOString();
    const entries = facts.map((fact, index): TracerLogEntry => ({ seq: this.#lastSeq + index + 1, at, fact }));
    const fd = fs.openSync(this.#path, 'a');
    try {
      fs.writeSync(fd, entries.map((entry) => JSON.stringify(entry) + '\n').join(''));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.#lastSeq += entries.length;
    return entries.map((entry) => entry.seq);
  }

  async *read(fromSeq = 0): AsyncIterable<TracerLogEntry> {
    for (const entry of readEntries(this.#path).entries) if (entry.seq > fromSeq) yield entry;
  }
}

function readEntries(path: string): { entries: TracerLogEntry[]; validBytes: number } {
  if (!fs.existsSync(path)) return { entries: [], validBytes: 0 };
  const text = fs.readFileSync(path, 'utf8');
  const entries: TracerLogEntry[] = [];
  let validBytes = 0;
  for (const line of text.split('\n')) {
    const end = validBytes + Buffer.byteLength(line) + 1;
    if (end > Buffer.byteLength(text)) break; // last line has no newline: torn
    try {
      if (line) entries.push(JSON.parse(line) as TracerLogEntry);
    } catch {
      break; // torn tail from a crash mid-write
    }
    validBytes = end;
  }
  return { entries, validBytes };
}
