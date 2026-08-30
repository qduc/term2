import { safeUtf16Slice } from './bounded-json.js';

/** Builds a match-centered, surrogate-safe UTF-16 snippet from source text. */
export function matchCenteredSnippet(
  content: string,
  terms: string[],
  maxChars: number,
): { text: string; truncated: boolean } {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  const match = earliestMatch(content, terms);
  if (content.length <= limit) return { text: content, truncated: false };
  if (!match) return prefixSnippet(content, limit);
  if (limit === 0) return { text: '', truncated: true };
  if (limit === 1) return { text: '…', truncated: true };

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
  const boundaries = lowerCaseBoundaries(content, lowered);
  let best: { start: number; end: number; termOrder: number } | undefined;
  for (let termOrder = 0; termOrder < terms.length; termOrder++) {
    const term = terms[termOrder]!;
    if (!term) continue;
    let loweredStart = lowered.indexOf(term);
    while (loweredStart !== -1) {
      const source = sourceRangeForLoweredMatch(boundaries, loweredStart, loweredStart + term.length);
      if (source && (!best || source.start < best.start || (source.start === best.start && termOrder < best.termOrder)))
        best = { ...source, termOrder };
      loweredStart = lowered.indexOf(term, loweredStart + 1);
    }
  }
  return best;
}

function lowerCaseBoundaries(content: string, lowered: string) {
  const boundaries: Array<{ sourceStart: number; sourceEnd: number; lowerStart: number; lowerEnd: number }> = [];
  let sourceStart = 0;
  let lowerStart = 0;
  while (sourceStart < content.length) {
    const sourceEnd =
      sourceStart +
      (isHighSurrogate(content.charCodeAt(sourceStart)) && isLowSurrogate(content.charCodeAt(sourceStart + 1)) ? 2 : 1);
    const lowerEnd = lowerStart + content.slice(sourceStart, sourceEnd).toLowerCase().length;
    boundaries.push({ sourceStart, sourceEnd, lowerStart, lowerEnd });
    sourceStart = sourceEnd;
    lowerStart = lowerEnd;
  }
  // Most strings map per code point. Context-sensitive lowercasing is rare,
  // but prefix lengths keep source positions correct when it does not.
  if (lowerStart === lowered.length) return boundaries;
  return boundaries.map((boundary) => ({
    ...boundary,
    lowerStart: content.slice(0, boundary.sourceStart).toLowerCase().length,
    lowerEnd: content.slice(0, boundary.sourceEnd).toLowerCase().length,
  }));
}

function sourceRangeForLoweredMatch(
  boundaries: Array<{ sourceStart: number; sourceEnd: number; lowerStart: number; lowerEnd: number }>,
  lowerStart: number,
  lowerEnd: number,
) {
  const first = boundaries.find((boundary) => boundary.lowerEnd > lowerStart);
  let last: (typeof boundaries)[number] | undefined;
  for (let index = boundaries.length - 1; index >= 0; index--) {
    const boundary = boundaries[index]!;
    if (boundary.lowerStart < lowerEnd) {
      last = boundary;
      break;
    }
  }
  return first && last ? { start: first.sourceStart, end: last.sourceEnd } : undefined;
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
