import type { MemoryMetadata, MemorySearchResult } from './memory-store.js';
import { matchCenteredSnippet } from '../../utils/output/text-snippet.js';

export const CONTENT_SNIPPET_CHARS = 240;

export type ScopedMemorySearchResult = MemorySearchResult & { scope: 'global' | 'project' };

export function queryTerms(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => term.toLowerCase());
}

export function scoreMemorySearch(memory: MemoryMetadata, content: string, terms: string[]) {
  let score = 0;
  const matchedFields = new Set<MemorySearchResult['matchedFields'][number]>();
  const id = memory.id.toLowerCase();
  const title = memory.title.toLowerCase();
  const summary = memory.summary.toLowerCase();
  const tags = memory.tags.map((tag) => tag.toLowerCase());
  const loweredContent = content.toLowerCase();
  for (const term of terms) {
    if (id === term) {
      score += 100;
      matchedFields.add('id');
    } else if (id.includes(term)) {
      score += 20;
      matchedFields.add('id');
    }
    if (title.includes(term)) {
      score += 15;
      matchedFields.add('title');
    }
    if (tags.some((tag) => tag.includes(term))) {
      score += 12;
      matchedFields.add('tags');
    }
    if (summary.includes(term)) {
      score += 8;
      matchedFields.add('summary');
    }
    if (loweredContent.includes(term)) {
      score += 2;
      matchedFields.add('content');
    }
  }
  return { score, matchedFields: [...matchedFields] };
}

export function rankMemorySearchResults(results: ScopedMemorySearchResult[]): ScopedMemorySearchResult[] {
  return [...results].sort(
    (a, b) =>
      b.score - a.score ||
      b.memory.updatedAt.localeCompare(a.memory.updatedAt) ||
      (a.scope === b.scope ? 0 : a.scope === 'global' ? -1 : 1) ||
      a.memory.id.localeCompare(b.memory.id),
  );
}

export function contentSnippet(content: string, terms: string[]): { text: string; truncated: boolean } {
  return matchCenteredSnippet(content, terms, CONTENT_SNIPPET_CHARS);
}
