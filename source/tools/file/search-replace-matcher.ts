import path from 'path';

export const GAP_MARKER = '<...>';

export type IndexedMatch = { startIndex: number; endIndex: number };

export type MatchInfo =
  | { type: 'exact'; count: number }
  | { type: 'relaxed' | 'normalized' | 'anchor' | 'escaped' | 'boundary'; count: number; matches: IndexedMatch[] }
  | { type: 'gap'; count: number; matches: IndexedMatch[] }
  | { type: 'none'; diagnostic?: string };

interface SearchReplaceOperation {
  path: string;
  search_content: string;
  replace_content: string;
}

interface EditCache {
  key: string;
  matchInfo: MatchInfo;
  content: string;
  eol: string;
}

export class SearchReplaceEditCache {
  private lastEditCache: EditCache | null = null;

  get(params: SearchReplaceOperation, content: string): EditCache | null {
    const key = getEditCacheKey(params);
    if (this.lastEditCache && this.lastEditCache.key === key && this.lastEditCache.content === content) {
      return this.lastEditCache;
    }
    return null;
  }

  set(params: SearchReplaceOperation, matchInfo: MatchInfo, content: string, eol: string): void {
    this.lastEditCache = {
      key: getEditCacheKey(params),
      matchInfo,
      content,
      eol,
    };
  }
}

function getEditCacheKey(params: SearchReplaceOperation): string {
  return JSON.stringify(params);
}

export function detectEOL(content: string): string {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfCount = (content.match(/(?<!\r)\n/g) || []).length;
  return crlfCount > lfCount ? '\r\n' : '\n';
}

export function normalizeToEOL(content: string, eol: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\n/g, eol);
}

function removeLeadingFilepathComment(content: string, filePath: string): string {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return content;

  const firstLine = lines[0].trim();
  const basename = path.basename(filePath);
  const patterns = [
    /^\/\/\s*.*[\\/]?[\w.-]+\.[a-zA-Z]+\s*$/,
    /^#\s*.*[\\/]?[\w.-]+\.[a-zA-Z]+\s*$/,
    /^\/\*\s*.*[\\/]?[\w.-]+\.[a-zA-Z]+\s*\*\/\s*$/,
    /^<!--\s*.*[\\/]?[\w.-]+\.[a-zA-Z]+\s*-->\s*$/,
  ];
  const isFilepathComment = patterns.some((pattern) => pattern.test(firstLine)) && firstLine.includes(basename);
  return isFilepathComment ? lines.slice(1).join('\n') : content;
}

export function normalizeSearchContent(content: string, filePath: string, eol: string): string {
  return normalizeToEOL(removeLeadingFilepathComment(content, filePath), eol);
}

interface LineInfo {
  text: string;
  trimmed: string;
  start: number;
  end: number;
}

function parseFileLines(content: string): LineInfo[] {
  const lineInfos: LineInfo[] = [];
  const regex = /([^\r\n]*)(\r?\n|$)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (match.index === regex.lastIndex) regex.lastIndex++;
    const fullMatch = match[0];
    if (fullMatch.length === 0 && match.index >= content.length) break;

    const lineContent = match[1];
    lineInfos.push({
      text: lineContent,
      trimmed: lineContent.trim(),
      start: match.index,
      end: match.index + fullMatch.length,
    });
    if (match.index + fullMatch.length === content.length) break;
  }
  return lineInfos;
}

function findExactMatches(content: string, searchContent: string): IndexedMatch[] {
  const matches: IndexedMatch[] = [];
  let index = content.indexOf(searchContent);
  while (index !== -1) {
    matches.push({ startIndex: index, endIndex: index + searchContent.length });
    index = content.indexOf(searchContent, index + 1);
  }
  return matches;
}

function findBoundaryExactMatches(content: string, searchContent: string): IndexedMatch[] {
  return findExactMatches(content, searchContent).filter(({ startIndex, endIndex }) => {
    const before = startIndex > 0 ? content[startIndex - 1] : '';
    const after = endIndex < content.length ? content[endIndex] : '';
    return (startIndex === 0 || /\s/.test(before)) && (endIndex === content.length || /\s/.test(after));
  });
}

function normalizeWhitespaceWithMap(content: string): { normalized: string; indexMap: number[] } {
  let normalized = '';
  const indexMap: number[] = [];
  let inWhitespace = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (/\s/.test(char)) {
      if (!inWhitespace && normalized.length > 0) {
        normalized += ' ';
        indexMap.push(i);
      }
      inWhitespace = true;
      continue;
    }
    inWhitespace = false;
    normalized += char;
    indexMap.push(i);
  }

  if (normalized.endsWith(' ')) {
    normalized = normalized.slice(0, -1);
    indexMap.pop();
  }
  return { normalized, indexMap };
}

function normalizeWhitespace(content: string): string {
  return normalizeWhitespaceWithMap(content).normalized;
}

function findSegmentInLines(
  lineInfos: LineInfo[],
  segmentLines: string[],
  fromLineIdx: number,
): { startLineIdx: number; endLineIdx: number } | null {
  for (let i = fromLineIdx; i <= lineInfos.length - segmentLines.length; i++) {
    if (segmentLines.every((line, offset) => lineInfos[i + offset].trimmed === line)) {
      return { startLineIdx: i, endLineIdx: i + segmentLines.length };
    }
  }
  return null;
}

function findGapMatches(content: string, searchContent: string): MatchInfo {
  const segmentLineSets = searchContent.split(GAP_MARKER).map((segment) =>
    segment
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  if (segmentLineSets.some((lines) => lines.length === 0)) {
    return {
      type: 'none',
      diagnostic:
        'Gap pattern has an empty segment — every part separated by <...> must contain at least one non-blank line.',
    };
  }

  const lineInfos = parseFileLines(content);
  const matches: IndexedMatch[] = [];
  let headEverMatched = false;
  let maxSegmentsMatched = 0;
  let searchFrom = 0;

  while (searchFrom <= lineInfos.length - segmentLineSets[0].length) {
    const firstMatch = findSegmentInLines(lineInfos, segmentLineSets[0], searchFrom);
    if (!firstMatch) break;
    headEverMatched = true;

    let valid = true;
    let segmentsMatched = 1;
    let lastEndLineIdx = firstMatch.endLineIdx;
    for (let index = 1; index < segmentLineSets.length; index++) {
      const nextMatch = findSegmentInLines(lineInfos, segmentLineSets[index], lastEndLineIdx);
      if (!nextMatch) {
        valid = false;
        break;
      }
      segmentsMatched++;
      lastEndLineIdx = nextMatch.endLineIdx;
    }
    maxSegmentsMatched = Math.max(maxSegmentsMatched, segmentsMatched);

    if (valid) {
      matches.push({
        startIndex: lineInfos[firstMatch.startLineIdx].start,
        endIndex: lineInfos[lastEndLineIdx - 1].end,
      });
    }
    searchFrom = firstMatch.startLineIdx + 1;
  }

  if (matches.length > 0) return { type: 'gap', count: matches.length, matches };
  if (!headEverMatched) {
    return {
      type: 'none',
      diagnostic: `Gap pattern did not match: the head anchor (starting ${JSON.stringify(
        segmentLineSets[0][0],
      )}) was not found in the file. Recheck the first anchor's exact text.`,
    };
  }

  return {
    type: 'none',
    diagnostic: `Gap pattern did not match: the head anchor matched, but the next anchor (starting ${JSON.stringify(
      segmentLineSets[maxSegmentsMatched]?.[0] ?? '',
    )}) was not found after it. Recheck that anchor's text and that anchors appear in order.`,
  };
}

function findRelaxedMatches(content: string, searchContent: string): IndexedMatch[] {
  const searchLines = searchContent.split(/\r?\n/).map((line) => line.trim());
  const lineInfos = parseFileLines(content);
  const matches: IndexedMatch[] = [];
  for (let index = 0; index <= lineInfos.length - searchLines.length; index++) {
    if (searchLines.every((line, offset) => lineInfos[index + offset].trimmed === line)) {
      matches.push({
        startIndex: lineInfos[index].start,
        endIndex: lineInfos[index + searchLines.length - 1].end,
      });
    }
  }
  return matches;
}

function longestCommonSubsequenceLength(left: string[], right: string[]): number {
  const previous = new Array(right.length + 1).fill(0);
  for (const leftLine of left) {
    const current = new Array(right.length + 1).fill(0);
    for (let index = 1; index <= right.length; index++) {
      current[index] =
        leftLine === right[index - 1] ? previous[index - 1] + 1 : Math.max(previous[index], current[index - 1]);
    }
    for (let index = 0; index < current.length; index++) previous[index] = current[index];
  }
  return previous[right.length];
}

function findAnchorMatches(content: string, searchContent: string): IndexedMatch[] {
  const searchLines = searchContent.split(/\r?\n/).map((line) => line.trim());
  if (searchLines.length < 4 || searchLines.some((line) => line.length === 0)) return [];

  const lineInfos = parseFileLines(content);
  const anchorSize = searchLines.length >= 5 ? 2 : 1;
  const head = searchLines.slice(0, anchorSize);
  const tail = searchLines.slice(-anchorSize);
  const maxSpanLength = Math.max(searchContent.length * 2, searchContent.length + 80);
  const matches: IndexedMatch[] = [];

  for (let start = 0; start <= lineInfos.length - searchLines.length; start++) {
    if (!head.every((line, offset) => lineInfos[start + offset]?.trimmed === line)) continue;

    for (let end = start + anchorSize; end < lineInfos.length; end++) {
      const tailStart = end - anchorSize + 1;
      if (!tail.every((line, offset) => lineInfos[tailStart + offset]?.trimmed === line)) continue;

      const startIndex = lineInfos[start].start;
      const endIndex = lineInfos[end].end;
      if (endIndex - startIndex > maxSpanLength) break;

      const candidateLines = lineInfos.slice(start, end + 1).map((line) => line.trimmed);
      const similarity =
        longestCommonSubsequenceLength(searchLines, candidateLines) /
        Math.max(searchLines.length, candidateLines.length);
      if (similarity >= 0.75) matches.push({ startIndex, endIndex });
    }
  }
  return matches;
}

function findNormalizedMatches(content: string, searchContent: string): IndexedMatch[] {
  const normalizedSearch = normalizeWhitespace(searchContent);
  if (normalizedSearch.length === 0) return [];

  const { normalized: normalizedContent, indexMap } = normalizeWhitespaceWithMap(content);
  const matches: IndexedMatch[] = [];
  let normalizedIndex = normalizedContent.indexOf(normalizedSearch);
  while (normalizedIndex !== -1) {
    const beforeIndex = normalizedIndex - 1;
    const afterIndex = normalizedIndex + normalizedSearch.length;
    const hasLeadingBoundary = beforeIndex < 0 || normalizedContent[beforeIndex] === ' ';
    const hasTrailingBoundary = afterIndex >= normalizedContent.length || normalizedContent[afterIndex] === ' ';
    if (hasLeadingBoundary && hasTrailingBoundary) {
      matches.push({
        startIndex: indexMap[normalizedIndex],
        endIndex: indexMap[normalizedIndex + normalizedSearch.length - 1] + 1,
      });
    }
    normalizedIndex = normalizedContent.indexOf(normalizedSearch, normalizedIndex + 1);
  }
  return matches;
}

function unescapeSearchContent(content: string): string {
  return content.replace(/\\(r|n|t|\\)/g, (_match, escaped: string) => {
    if (escaped === 'r') return '\r';
    if (escaped === 'n') return '\n';
    if (escaped === 't') return '\t';
    return '\\';
  });
}

export function findMatchesInContent(content: string, searchContent: string): MatchInfo {
  if (searchContent.includes(GAP_MARKER)) return findGapMatches(content, searchContent);

  const exactMatches = findExactMatches(content, searchContent);
  if (exactMatches.length > 0) return { type: 'exact', count: exactMatches.length };

  const relaxedMatches = findRelaxedMatches(content, searchContent);
  if (relaxedMatches.length > 0) return { type: 'relaxed', count: relaxedMatches.length, matches: relaxedMatches };

  const anchorMatches = findAnchorMatches(content, searchContent);
  if (anchorMatches.length > 0) return { type: 'anchor', count: anchorMatches.length, matches: anchorMatches };

  const normalizedMatches = findNormalizedMatches(content, searchContent);
  if (normalizedMatches.length > 0) {
    return { type: 'normalized', count: normalizedMatches.length, matches: normalizedMatches };
  }

  const unescapedSearch = unescapeSearchContent(searchContent);
  if (unescapedSearch !== searchContent) {
    const escapedMatches = findExactMatches(content, unescapedSearch);
    if (escapedMatches.length > 0) {
      return { type: 'escaped', count: escapedMatches.length, matches: escapedMatches };
    }
  }

  const trimmedSearch = searchContent.trim();
  if (trimmedSearch !== searchContent && trimmedSearch.length > 0) {
    const boundaryMatches = findBoundaryExactMatches(content, trimmedSearch);
    if (boundaryMatches.length > 0) {
      return { type: 'boundary', count: boundaryMatches.length, matches: boundaryMatches };
    }
  }

  return { type: 'none' };
}

export function prepareMatchContext(
  operation: SearchReplaceOperation,
  content: string,
  editCache: SearchReplaceEditCache,
): { eol: string; normalizedSearchContent: string; matchInfo: MatchInfo; fromCache: boolean } {
  const cachedEdit = editCache.get(operation, content);
  if (cachedEdit) {
    return {
      eol: cachedEdit.eol,
      normalizedSearchContent: normalizeSearchContent(operation.search_content, operation.path, cachedEdit.eol),
      matchInfo: cachedEdit.matchInfo,
      fromCache: true,
    };
  }

  const eol = detectEOL(content);
  const normalizedSearchContent = normalizeSearchContent(operation.search_content, operation.path, eol);
  const matchInfo = findMatchesInContent(content, normalizedSearchContent);
  editCache.set(operation, matchInfo, content, eol);
  return { eol, normalizedSearchContent, matchInfo, fromCache: false };
}
