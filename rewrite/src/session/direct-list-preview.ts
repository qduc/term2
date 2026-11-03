/** Bounded reads for a resume row. Never loads a conversation body. */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const TITLE_CAP_BYTES = 8 * 1024 * 1024;

/** Same shortening as the full-replay title in the session store. */
function shorten(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

function titleFromLine(line: Buffer): string | undefined {
  if (!line.includes('turn_started')) return undefined;
  let fact: {
    type?: string;
    input?: readonly { type?: string; content?: readonly { type?: string; text?: string }[] }[];
  };
  try {
    fact = JSON.parse(line.toString('utf8')).fact;
  } catch {
    return undefined;
  }
  if (fact?.type !== 'turn_started' || !fact.input) return undefined;
  for (const item of fact.input) {
    if (item.type !== 'user_message' || !item.content) continue;
    const text = item.content
      .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return shorten(text);
  }
  return undefined;
}

/** First user prompt, from the start of the root log, or absent when it is not in the cap. */
export function readDirectResumeTitle(filePath: string): string | undefined {
  const fd = openSync(filePath, 'r');
  try {
    let pending = Buffer.alloc(0);
    let position = 0;
    while (position < TITLE_CAP_BYTES) {
      const want = Math.min(64 * 1024, TITLE_CAP_BYTES - position);
      const chunk = Buffer.alloc(want);
      const n = readSync(fd, chunk, 0, want, position);
      if (n <= 0) return undefined;
      position += n;
      pending = Buffer.concat([pending, chunk.subarray(0, n)]);
      let start = 0;
      while (start < pending.length) {
        const end = pending.indexOf(0x0a, start);
        if (end < 0) break;
        const title = titleFromLine(pending.subarray(start, end));
        if (title) return title;
        start = end + 1;
      }
      pending = pending.subarray(start);
      if (pending.length >= TITLE_CAP_BYTES) return undefined;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Timestamp of the last terminated line, when that line fits in the tail. */
export function readDirectResumeUpdatedAt(filePath: string): string | undefined {
  const fd = openSync(filePath, 'r');
  try {
    const size = Number(fstatSync(fd).size);
    if (!Number.isFinite(size) || size <= 0) return undefined;
    const start = Math.max(0, size - 64 * 1024);
    const buf = Buffer.alloc(size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    const lines = buf.subarray(0, n).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    if (lines.at(-1) !== '') lines.pop();
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) continue;
      try {
        const at = JSON.parse(line).at;
        if (typeof at === 'string') return at;
      } catch {
        continue;
      }
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}
