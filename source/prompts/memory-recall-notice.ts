/**
 * Per-turn memory recall travels on the user turn, never in the instructions:
 * rewriting instructions per turn changes the cached prefix and forces the
 * provider to re-read the whole conversation uncached.
 *
 * The block is model input only. Everything the app shows, rewinds to, or
 * treats as user-authored text must strip it first.
 */
export const MEMORY_RECALL_OPEN = '<memory-recall>';
export const MEMORY_RECALL_CLOSE = '</memory-recall>';

const MEMORY_RECALL_HEADER =
  'Persistent memory summaries that may be relevant to the message below. Added automatically by the harness, not written by the user. Treat them as leads, not verified facts; memory_get returns full evidence.';

const MEMORY_RECALL_PREFIX = /^<memory-recall>\n[\s\S]*?\n<\/memory-recall>\n*/;
const RECALLED_MEMORY_LINE = /^- (global|project) \/ `([^`]+)`/gm;

export type RecallLine = { scope: 'global' | 'project'; id: string; title: string; summary: string };

/** Stable identity of a memory across both scopes. */
export function recallKey(scope: 'global' | 'project', id: string): string {
  return `${scope}:${id}`;
}

/** One physical line whose text cannot close the block early. */
function inline(text: string): string {
  return text.replace(/\s+/g, ' ').replaceAll(MEMORY_RECALL_CLOSE, '').trim();
}

export function renderRecallLine(line: RecallLine): string {
  return `- ${line.scope} / \`${line.id}\` — ${inline(line.title)} — ${inline(line.summary)}`;
}

export function renderMemoryRecall(lines: readonly string[]): string {
  return [MEMORY_RECALL_OPEN, MEMORY_RECALL_HEADER, ...lines, MEMORY_RECALL_CLOSE].join('\n');
}

/** Characters a recall block spends before its lines; each line adds its length plus one. */
export const MEMORY_RECALL_OVERHEAD = renderMemoryRecall([]).length;

export function withMemoryRecall(recall: string, text: string): string {
  if (!recall) return text;
  return text ? `${recall}\n\n${text}` : recall;
}

/** Recover the user's own words from a turn that carries a recall block. */
export function stripMemoryRecall(text: string): string {
  return text.startsWith(MEMORY_RECALL_OPEN) ? text.replace(MEMORY_RECALL_PREFIX, '') : text;
}

/** Keys of memories already recalled into the given user-turn texts. */
export function recalledMemoryKeys(texts: Iterable<string>): Set<string> {
  const keys = new Set<string>();
  for (const text of texts) {
    const block = text.startsWith(MEMORY_RECALL_OPEN) ? text.match(MEMORY_RECALL_PREFIX)?.[0] : undefined;
    if (!block) continue;
    for (const match of block.matchAll(RECALLED_MEMORY_LINE)) {
      keys.add(recallKey(match[1] as 'global' | 'project', match[2]!));
    }
  }
  return keys;
}
