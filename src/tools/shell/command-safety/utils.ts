import type { Word, WordPart } from 'unbash';

// Extract a best-effort string for a word/arg node, including expansions.
export function extractWordText(word: Word | WordPart | undefined | null): string | undefined {
  if (!word) return undefined;
  if (typeof word === 'string') return word;
  if ('value' in word && typeof word.value === 'string') return word.value;
  if ('text' in word && typeof word.text === 'string') return word.text;
  if ('content' in word && typeof word.content === 'string') return word.content;
  if ('parameter' in word && typeof word.parameter === 'string') return `$${word.parameter}`;
  if ('parts' in word && Array.isArray(word.parts)) {
    return word.parts.map((part) => extractWordText(part) ?? '').join('');
  }
  return undefined;
}
