import path from 'node:path';
import type { DiffStatEntry } from './types.js';

export function buildDiffStat(
  filesChanged: string[],
  diffDeltas: Map<string, { added: number; deleted: number }>,
): DiffStatEntry[] {
  const seen = new Set<string>();
  const entries: DiffStatEntry[] = [];
  for (const file of filesChanged) {
    if (seen.has(file)) continue;
    seen.add(file);
    const delta = diffDeltas.get(file) ?? diffDeltas.get(resolveSafe(file));
    entries.push({
      path: file,
      added: delta?.added ?? 0,
      deleted: delta?.deleted ?? 0,
    });
  }
  return entries;
}

function resolveSafe(p: string): string {
  try {
    return path.resolve(p);
  } catch {
    return p;
  }
}
