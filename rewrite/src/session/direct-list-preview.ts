/** Bounded reads for a resume row. Never loads a conversation body. */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { directLogicalEnds } from './direct-rolling-log.js';

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
    if (text) return text;
  }
  return undefined;
}

/** First user prompt, from the start of the root log, or absent when it is not in the cap. */
export function readDirectResumeTitle(filePath: string): string | undefined {
  const text = readFirstPrompt(filePath);
  return text === undefined ? undefined : shorten(text);
}

/**
 * `--resume ls` row details legacy reads from the file: the whole first prompt (legacy shortens it
 * itself) and the head file's mtime (legacy ages rows by mtime, not by the last line's time).
 */
export function readDirectListDetails(
  directory: string,
  logicalIds: readonly string[],
): ReadonlyMap<string, { readonly firstUserMessage?: string; readonly updatedAt?: string }> {
  const ends = directLogicalEnds(path.resolve(directory));
  return new Map(
    logicalIds.map((id) => {
      const end = ends.get(id);
      let firstUserMessage: string | undefined;
      let updatedAt: string | undefined;
      try {
        firstUserMessage = end ? readFirstPrompt(end.rootPath) : undefined;
        updatedAt = end ? statSync(end.headPath).mtime.toISOString() : undefined;
      } catch {
        /* The catalogue row still lists it. */
      }
      return [
        id,
        {
          ...(firstUserMessage === undefined ? {} : { firstUserMessage }),
          ...(updatedAt === undefined ? {} : { updatedAt }),
        },
      ];
    }),
  );
}

function readFirstPrompt(filePath: string): string | undefined {
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
