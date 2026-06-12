export function appendMessagesCapped<T>(existing: readonly T[], additions: readonly T[], maxMessages: number): T[] {
  if (maxMessages <= 0) return [];

  if (additions.length === 0 && existing.length <= maxMessages) {
    return existing.slice();
  }

  const combinedLength = existing.length + additions.length;
  if (combinedLength <= maxMessages) {
    return [...existing, ...additions];
  }

  const start = combinedLength - maxMessages;
  const trimmedExisting = existing.slice(Math.max(0, start - additions.length));
  return [...trimmedExisting, ...additions].slice(-maxMessages);
}
