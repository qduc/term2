import { safeUtf16Slice } from './bounded-json.js';

/** Builds a match-centered, surrogate-safe UTF-16 snippet from source text. */
export function matchCenteredSnippet(
  content: string,
  terms: string[],
  maxChars: number,
): { text: string; truncated: boolean } {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  if (content.length <= limit) return { text: content, truncated: false };
  if (limit === 0) return { text: '', truncated: true };
  if (limit === 1) return { text: '…', truncated: true };
  const match = earliestMatch(content, terms);
  if (!match) return prefixSnippet(content, limit);

  let hasPrefix = true;
  let hasSuffix = true;
  for (let attempt = 0; attempt < 4; attempt++) {
    const sourceBudget = limit - Number(hasPrefix) - Number(hasSuffix);
    const center = Math.floor((match.start + match.end) / 2);
    const start = Math.max(0, Math.min(content.length - sourceBudget, center - Math.floor(sourceBudget / 2)));
    const end = Math.min(content.length, start + sourceBudget);
    const range = safeRange(content, start, end);
    const nextHasPrefix = range.start > 0;
    const nextHasSuffix = range.end < content.length;
    if (nextHasPrefix === hasPrefix && nextHasSuffix === hasSuffix)
      return {
        text: `${nextHasPrefix ? '…' : ''}${content.slice(range.start, range.end)}${nextHasSuffix ? '…' : ''}`,
        truncated: true,
      };
    hasPrefix = nextHasPrefix;
    hasSuffix = nextHasSuffix;
  }
  return prefixSnippet(content, limit);
}

function earliestMatch(content: string, terms: string[]): { start: number; end: number } | undefined {
  const lowered = content.toLowerCase();
  // ASCII lowercasing preserves source offsets and needs no per-character
  // mapping. Large tool outputs commonly take this path.
  const ascii = /^[\x00-\x7f]*$/.test(content);
  let best: { start: number; end: number; termOrder: number } | undefined;
  for (let termOrder = 0; termOrder < terms.length; termOrder++) {
    const term = terms[termOrder]!;
    if (!term) continue;
    const loweredStart = lowered.indexOf(term);
    if (loweredStart !== -1) {
      // Source positions are monotonic: later occurrences of the same term
      // cannot precede its first match, even when lowercase expands a character.
      const source = ascii
        ? { start: loweredStart, end: loweredStart + term.length }
        : sourceRangeForLoweredMatch(content, loweredStart, loweredStart + term.length);
      if (source && (!best || source.start < best.start || (source.start === best.start && termOrder < best.termOrder)))
        best = { ...source, termOrder };
    }
  }
  return best;
}

function sourceRangeForLoweredMatch(content: string, matchStart: number, matchEnd: number) {
  let sourceStart = 0;
  let lowerStart = 0;
  let start: number | undefined;
  // Default (non-locale) lowercasing preserves code-point order. Map only
  // through this first match, without allocating a boundary for every character
  // of a potentially megabyte-long tool result. Contextual final sigma changes
  // the character, but not its length; İ's expansion consumes two lowered units.
  while (sourceStart < content.length && lowerStart < matchEnd) {
    const sourceEnd =
      sourceStart +
      (isHighSurrogate(content.charCodeAt(sourceStart)) && isLowSurrogate(content.charCodeAt(sourceStart + 1)) ? 2 : 1);
    const lowerEnd = lowerStart + content.slice(sourceStart, sourceEnd).toLowerCase().length;
    if (start === undefined && lowerEnd > matchStart) start = sourceStart;
    if (lowerEnd >= matchEnd) return start === undefined ? undefined : { start, end: sourceEnd };
    sourceStart = sourceEnd;
    lowerStart = lowerEnd;
  }
  return undefined;
}

function safeRange(content: string, start: number, end: number) {
  const text = safeUtf16Slice(content, start, end);
  const safeStart =
    start > 0 && isLowSurrogate(content.charCodeAt(start)) && isHighSurrogate(content.charCodeAt(start - 1))
      ? start + 1
      : start;
  return { start: safeStart, end: safeStart + text.length };
}

function prefixSnippet(content: string, limit: number): { text: string; truncated: boolean } {
  if (limit === 0) return { text: '', truncated: true };
  if (limit === 1) return { text: '…', truncated: true };
  return { text: `${safeUtf16Slice(content, 0, limit - 1)}…`, truncated: true };
}

function isHighSurrogate(value: number) {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number) {
  return value >= 0xdc00 && value <= 0xdfff;
}
