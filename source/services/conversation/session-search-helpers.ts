export const SNIPPET_CHARS = 240;

export function termsFor(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => term.toLowerCase());
}

export function scoreText(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  return terms.reduce(
    (total, term) => total + (lower === term ? 100 : lower.startsWith(term) ? 20 : lower.includes(term) ? 2 : 0),
    0,
  );
}
