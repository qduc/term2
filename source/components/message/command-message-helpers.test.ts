import { it, expect } from 'vitest';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_SEARCH_REPLACE } from '../../tools/tool-names.js';
import {
  classifySearchKind,
  countDiffStats,
  formatToolArgs,
  getFirstParagraph,
  getMatchCount,
  parseCodeContextSearchOutput,
  parseCodeOutlineOutput,
  parseGrepOutput,
  parseReadFileOutput,
  parseSubagentOutput,
  parseWebFetchOutput,
  parseWebSearchOutput,
} from './command-message-helpers.js';

it('getMatchCount returns 0 when output is empty or undefined', () => {
  expect(getMatchCount(undefined, 'grep -rn hello source/', '')).toBe(0);
  expect(getMatchCount(undefined, 'grep -rn hello source/', undefined)).toBe(0);
});

it('getMatchCount returns 0 for "No matches found." output', () => {
  expect(getMatchCount('grep', 'grep', 'No matches found.')).toBe(0);
});

it('getMatchCount returns 0 for grep tool when structured parser returns null (unparseable output)', () => {
  // Output that parseGrepOutput cannot decode (no file:line:content pattern) should not
  // fall through to the shell fallback and miscount as 1 match.
  expect(getMatchCount('grep', 'grep', 'Search failed: some rg error')).toBe(0);
  expect(getMatchCount('grep', 'grep', 'some unexpected single line')).toBe(0);
});

it('getMatchCount returns 0 for glob tool when structured parser returns null', () => {
  // Output that parseFindFilesOutput cannot decode should return 0, not fall through.
  expect(getMatchCount('glob', 'glob', 'Error: no such directory')).toBe(0);
});

it('getMatchCount returns 0 for "No files found matching pattern: ..." output', () => {
  expect(getMatchCount('glob', 'glob', 'No files found matching pattern: *.ts')).toBe(0);
});

it('getMatchCount returns 0 for fallback shell output indicating no results', () => {
  expect(getMatchCount(undefined, 'grep hello', 'No matches found.')).toBe(0);
  expect(getMatchCount(undefined, 'find . -name "*.ts"', 'No files found')).toBe(0);
});

it('getMatchCount returns the sum of matches across files for structured grep output', () => {
  const output = 'file1.ts:1:hello\nfile1.ts:3:hello again\nfile2.ts:2:hello';

  expect(getMatchCount('grep', 'grep', output)).toBe(3);
});

it('getMatchCount returns the file count for structured glob output', () => {
  const output = 'src/a.ts\nsrc/b.ts\nsrc/c.ts';

  expect(getMatchCount('glob', 'glob', output)).toBe(3);
});

it('getMatchCount falls through to the shell fallback when toolName is undefined', () => {
  const output = 'src/a.ts:1:hello\nsrc/b.ts:3:hello';

  expect(getMatchCount(undefined, 'grep -rn hello source/', output)).toBe(2);
});

it('shell fallback skips Note lines', () => {
  const output = 'Note: searching from workspace root\nsrc/a.ts:1:hello';

  expect(getMatchCount(undefined, 'grep -rn hello source/', output)).toBe(1);
});

it('shell fallback skips Error lines', () => {
  const output = 'Error: permission denied\nsrc/a.ts:1:hello';

  expect(getMatchCount(undefined, 'grep -rn hello source/', output)).toBe(1);
});

it('shell fallback skips grep-prefixed error lines', () => {
  const output = 'grep: src/a.ts: No such file or directory\nsrc/b.ts:1:hello';

  expect(getMatchCount(undefined, 'grep -rn hello source/', output)).toBe(1);
});

it('shell fallback skips rg-prefixed error lines', () => {
  const output = 'rg: src/a.ts: No such file or directory\nsrc/b.ts:1:hello';

  expect(getMatchCount(undefined, 'rg hello source/', output)).toBe(1);
});

it('getMatchCount ignores rg stderr when structured grep output is present', () => {
  const output = 'rg: src/missing.ts: No such file or directory\nsrc/a.ts:1:hello\nsrc/b.ts:3:hello';

  expect(getMatchCount('grep', 'grep', output)).toBe(2);
});

it('parseGrepOutput ignores rg stderr lines and still parses matches', () => {
  const output = 'rg: src/missing.ts: No such file or directory\nsrc/a.ts:1:hello\nsrc/b.ts:3:hello';

  expect(parseGrepOutput(output)).toEqual({
    matchesByFile: {
      'src/a.ts': [{ lineNum: 1, content: 'hello' }],
      'src/b.ts': [{ lineNum: 3, content: 'hello' }],
    },
    note: null,
  });
});

it('shell fallback skips find-prefixed error lines', () => {
  const output = 'find: src/a.ts: Permission denied\nsrc/b.ts:1:hello';

  expect(getMatchCount(undefined, 'find . -name "*.ts"', output)).toBe(1);
});

it('shell fallback skips the separator line', () => {
  const output = 'src/a.ts:1:hello\n--\nsrc/b.ts:1:hello';

  expect(getMatchCount(undefined, 'grep -rn hello source/', output)).toBe(2);
});

it('shell fallback counts other non-empty lines', () => {
  const output = 'src/a.ts:1:hello\nplain summary line';

  expect(getMatchCount(undefined, 'grep -rn hello source/', output)).toBe(2);
});

it("classifySearchKind returns 'grep' for grep tools", () => {
  expect(classifySearchKind('grep', 'rg hello source/')).toBe('grep');
});

it("classifySearchKind returns 'glob' for glob tools", () => {
  expect(classifySearchKind('glob', 'glob')).toBe('glob');
});

it("classifySearchKind returns 'shell' for shell-routed search", () => {
  expect(classifySearchKind(undefined, 'grep -rn hello source/')).toBe('shell');
});

it('parseGrepOutput returns null when the first non-empty line is not a Note or match', () => {
  expect(parseGrepOutput('plain summary line\nfile1.ts:1:hello')).toBe(null);
});

it('parseReadFileOutput extracts metadata and content lines', () => {
  expect(parseReadFileOutput('File: source/a.ts (10 lines) [lines 2-4]\n===\nline 2\nline 3')).toEqual({
    filePath: 'source/a.ts',
    totalLines: 10,
    startLine: 2,
    endLine: 4,
    contentLines: ['line 2', 'line 3'],
  });
});

it('parseReadFileOutput strips line-number prefixes from real tool output', () => {
  expect(
    parseReadFileOutput('File: src/main.ts (3 lines) [lines 1-3]\n===\n1: import { foo }\n2: foo();\n3: bar();'),
  ).toEqual({
    filePath: 'src/main.ts',
    totalLines: 3,
    startLine: 1,
    endLine: 3,
    contentLines: ['import { foo }', 'foo();', 'bar();'],
  });
});

it('parseSubagentOutput extracts status metadata and remaining text', () => {
  expect(
    parseSubagentOutput('Status: completed\nTools used: shell, read_file\nFiles changed: source/a.ts\nSummary', {
      role: 'worker',
    }),
  ).toEqual({
    role: 'worker',
    status: 'completed',
    toolsUsed: 'shell, read_file',
    filesChanged: 'source/a.ts',
    mainText: 'Summary',
  });
});

it('parseSubagentOutput marks Error-prefixed output as failed', () => {
  expect(parseSubagentOutput('Error: failed\nDetails', { role: 'explorer' })).toEqual({
    role: 'explorer',
    status: 'failed',
    toolsUsed: '',
    filesChanged: '',
    mainText: 'Error: failed\nDetails',
  });
});

it('parseWebSearchOutput extracts answer and result entries', () => {
  const output = [
    '## Answer',
    'Use focused tests.',
    '## Search Results',
    '### 1. Docs',
    '**URL:** https://example.com/docs',
    '**Published:** 2026-01-01',
    'Relevant content.',
  ].join('\n');

  expect(parseWebSearchOutput(output)).toEqual({
    answer: 'Use focused tests.',
    results: [
      {
        title: 'Docs',
        url: 'https://example.com/docs',
        published: '2026-01-01',
        content: 'Relevant content.',
      },
    ],
  });
});

it('parseWebFetchOutput separates table of contents, notes, temp file, and content', () => {
  const output = [
    'Title: Example',
    'URL: https://example.com',
    '## Table of Contents',
    '- Intro',
    '---',
    'Body text',
    '**Note: Content still truncated.**',
    '**Full content saved to temp file: `/tmp/fetch.md`**',
    'The full content has been saved for reference.',
  ].join('\n');

  expect(parseWebFetchOutput(output)).toEqual({
    title: 'Example',
    url: 'https://example.com',
    toc: '- Intro',
    tempFile: '/tmp/fetch.md',
    notes: '**Note: Content still truncated.**',
    content: 'Body text',
  });
});

it('getFirstParagraph returns the first paragraph from multiline text', () => {
  expect(getFirstParagraph('Line one\n\nLine two')).toBe('Line one');
  expect(getFirstParagraph('  leading and trailing  ')).toBe('leading and trailing');
  expect(getFirstParagraph(undefined)).toBe('');
});

it('parseCodeOutlineOutput groups imports exports and declarations', () => {
  const output = [
    'FILE source/a.ts',
    'LANG ts',
    'IMPORTS',
    "import x from 'x';",
    'EXPORTS',
    'export { y };',
    'DECLARATIONS',
    'function y',
  ].join('\n');

  expect(parseCodeOutlineOutput(output)).toEqual({
    filePath: 'source/a.ts',
    lang: 'ts',
    imports: ["import x from 'x';"],
    exports: ['export { y };'],
    decls: ['function y'],
  });
});

it('parseCodeContextSearchOutput parses related file results', () => {
  const output = ['QUERY related', 'TARGET source/a.ts', 'source/b.ts', 'REL imports', 'WARNING ignored'].join('\n');

  expect(parseCodeContextSearchOutput(output)).toEqual({
    queryType: 'related',
    target: 'source/a.ts',
    relatedFiles: [{ filePath: 'source/b.ts', relations: 'imports' }],
  });
});

it('parseCodeContextSearchOutput parses symbol results', () => {
  const output = ['QUERY symbol', 'SYMBOL run', 'source/a.ts:12 function run exported'].join('\n');

  expect(parseCodeContextSearchOutput(output)).toEqual({
    queryType: 'symbol',
    symbol: 'run',
    results: [{ filePath: 'source/a.ts', lineNum: 12, kind: 'function', name: 'run', exported: true }],
  });
});

it('formatToolArgs parses stringified JSON args', () => {
  expect(formatToolArgs('read_file', '{"path":"source/a.ts","start_line":2,"end_line":4}')).toBe(
    '"source/a.ts" (lines 2-4)',
  );
});

it('formatToolArgs summarizes search replacement batches in concise mode', () => {
  expect(
    formatToolArgs(
      TOOL_NAME_SEARCH_REPLACE,
      {
        path: 'source/a.ts',
        replacements: [
          { search_content: 'old1', replace_content: 'new1' },
          { search_content: 'old2', replace_content: 'new2' },
        ],
      },
      'concise',
    ),
  ).toBe('"source/a.ts" (+ 1 more)');
});

it('formatToolArgs formats search_replace with replacements in standard mode', () => {
  expect(
    formatToolArgs(
      TOOL_NAME_SEARCH_REPLACE,
      {
        path: 'source/a.ts',
        replacements: [
          { search_content: 'old', replace_content: 'new' },
          { search_content: 'foo', replace_content: 'bar' },
        ],
      },
      'standard',
    ),
  ).toBe('"old" → "new" "source/a.ts" (+ 1 more)');
});

it('formatToolArgs formats search_replace with replacements that are truncated to 30 chars', () => {
  expect(
    formatToolArgs(
      TOOL_NAME_SEARCH_REPLACE,
      {
        path: 'source/a.ts',
        replacements: [{ search_content: 'AAAAAAAAABBBBBBBBBBBCCCCCCCCCCDDDDDDDDDD', replace_content: 'replacement' }],
      },
      'standard',
    ),
  ).toBe('"AAAAAAAAABBBBBBBBBBBCCCCCCCCCC..." → "replacement" "source/a.ts"');
});

it('formatToolArgs formats apply patch operation and path', () => {
  expect(formatToolArgs(TOOL_NAME_APPLY_PATCH, { type: 'update_file', path: 'source/a.ts' })).toBe(
    'update_file source/a.ts',
  );
});

it('countDiffStats ignores diff headers and hunk markers', () => {
  expect(countDiffStats('--- a/source/a.ts\n+++ b/source/a.ts\n@@ section\n-old\n+new\n context')).toEqual({
    added: 1,
    removed: 1,
  });
});
