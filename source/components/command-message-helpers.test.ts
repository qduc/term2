import test from 'ava';

import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_SEARCH_REPLACE } from '../tools/tool-names.js';
import {
  classifySearchKind,
  countDiffStats,
  formatToolArgs,
  getMatchCount,
  parseCodeContextSearchOutput,
  parseCodeOutlineOutput,
  parseGrepOutput,
  parseReadFileOutput,
  parseSubagentOutput,
  parseWebFetchOutput,
  parseWebSearchOutput,
} from './command-message-helpers.js';

test('getMatchCount returns 0 when output is empty or undefined', (t) => {
  t.is(getMatchCount(undefined, 'grep -rn hello source/', ''), 0);
  t.is(getMatchCount(undefined, 'grep -rn hello source/', undefined), 0);
});

test('getMatchCount returns 0 for "No matches found." output', (t) => {
  t.is(getMatchCount('grep', 'grep', 'No matches found.'), 0);
});

test('getMatchCount returns 0 for grep tool when structured parser returns null (unparseable output)', (t) => {
  // Output that parseGrepOutput cannot decode (no file:line:content pattern) should not
  // fall through to the shell fallback and miscount as 1 match.
  t.is(getMatchCount('grep', 'grep', 'Search failed: some rg error'), 0);
  t.is(getMatchCount('grep', 'grep', 'some unexpected single line'), 0);
});

test('getMatchCount returns 0 for find_files tool when structured parser returns null', (t) => {
  // Output that parseFindFilesOutput cannot decode should return 0, not fall through.
  t.is(getMatchCount('find_files', 'find_files', 'Error: no such directory'), 0);
});

test('getMatchCount returns 0 for "No files found matching pattern: ..." output', (t) => {
  t.is(getMatchCount('find_files', 'find_files', 'No files found matching pattern: *.ts'), 0);
});

test('getMatchCount returns 0 for fallback shell output indicating no results', (t) => {
  t.is(getMatchCount(undefined, 'grep hello', 'No matches found.'), 0);
  t.is(getMatchCount(undefined, 'find . -name "*.ts"', 'No files found'), 0);
});

test('getMatchCount returns the sum of matches across files for structured grep output', (t) => {
  const output = 'file1.ts:1:hello\nfile1.ts:3:hello again\nfile2.ts:2:hello';

  t.is(getMatchCount('grep', 'grep', output), 3);
});

test('getMatchCount returns the file count for structured find_files output', (t) => {
  const output = 'src/a.ts\nsrc/b.ts\nsrc/c.ts';

  t.is(getMatchCount('find_files', 'find_files', output), 3);
});

test('getMatchCount falls through to the shell fallback when toolName is undefined', (t) => {
  const output = 'src/a.ts:1:hello\nsrc/b.ts:3:hello';

  t.is(getMatchCount(undefined, 'grep -rn hello source/', output), 2);
});

test('shell fallback skips Note lines', (t) => {
  const output = 'Note: searching from workspace root\nsrc/a.ts:1:hello';

  t.is(getMatchCount(undefined, 'grep -rn hello source/', output), 1);
});

test('shell fallback skips Error lines', (t) => {
  const output = 'Error: permission denied\nsrc/a.ts:1:hello';

  t.is(getMatchCount(undefined, 'grep -rn hello source/', output), 1);
});

test('shell fallback skips grep-prefixed error lines', (t) => {
  const output = 'grep: src/a.ts: No such file or directory\nsrc/b.ts:1:hello';

  t.is(getMatchCount(undefined, 'grep -rn hello source/', output), 1);
});

test('shell fallback skips rg-prefixed error lines', (t) => {
  const output = 'rg: src/a.ts: No such file or directory\nsrc/b.ts:1:hello';

  t.is(getMatchCount(undefined, 'rg hello source/', output), 1);
});

test('getMatchCount ignores rg stderr when structured grep output is present', (t) => {
  const output = 'rg: src/missing.ts: No such file or directory\nsrc/a.ts:1:hello\nsrc/b.ts:3:hello';

  t.is(getMatchCount('grep', 'grep', output), 2);
});

test('parseGrepOutput ignores rg stderr lines and still parses matches', (t) => {
  const output = 'rg: src/missing.ts: No such file or directory\nsrc/a.ts:1:hello\nsrc/b.ts:3:hello';

  t.deepEqual(parseGrepOutput(output), {
    matchesByFile: {
      'src/a.ts': [{ lineNum: 1, content: 'hello' }],
      'src/b.ts': [{ lineNum: 3, content: 'hello' }],
    },
    note: null,
  });
});

test('shell fallback skips find-prefixed error lines', (t) => {
  const output = 'find: src/a.ts: Permission denied\nsrc/b.ts:1:hello';

  t.is(getMatchCount(undefined, 'find . -name "*.ts"', output), 1);
});

test('shell fallback skips the separator line', (t) => {
  const output = 'src/a.ts:1:hello\n--\nsrc/b.ts:1:hello';

  t.is(getMatchCount(undefined, 'grep -rn hello source/', output), 2);
});

test('shell fallback counts other non-empty lines', (t) => {
  const output = 'src/a.ts:1:hello\nplain summary line';

  t.is(getMatchCount(undefined, 'grep -rn hello source/', output), 2);
});

test("classifySearchKind returns 'grep' for grep tools", (t) => {
  t.is(classifySearchKind('grep', 'rg hello source/'), 'grep');
});

test("classifySearchKind returns 'find_files' for find_files tools", (t) => {
  t.is(classifySearchKind('find_files', 'find_files'), 'find_files');
});

test("classifySearchKind returns 'shell' for shell-routed search", (t) => {
  t.is(classifySearchKind(undefined, 'grep -rn hello source/'), 'shell');
});

test('parseGrepOutput returns null when the first non-empty line is not a Note or match', (t) => {
  t.is(parseGrepOutput('plain summary line\nfile1.ts:1:hello'), null);
});

test('parseReadFileOutput extracts metadata and content lines', (t) => {
  t.deepEqual(parseReadFileOutput('File: source/a.ts (10 lines) [lines 2-4]\n===\nline 2\nline 3'), {
    filePath: 'source/a.ts',
    totalLines: 10,
    startLine: 2,
    endLine: 4,
    contentLines: ['line 2', 'line 3'],
  });
});

test('parseSubagentOutput extracts status metadata and remaining text', (t) => {
  t.deepEqual(
    parseSubagentOutput('Status: completed\nTools used: shell, read_file\nFiles changed: source/a.ts\nSummary', {
      role: 'worker',
    }),
    {
      role: 'worker',
      status: 'completed',
      toolsUsed: 'shell, read_file',
      filesChanged: 'source/a.ts',
      mainText: 'Summary',
    },
  );
});

test('parseSubagentOutput marks Error-prefixed output as failed', (t) => {
  t.deepEqual(parseSubagentOutput('Error: failed\nDetails', { role: 'explorer' }), {
    role: 'explorer',
    status: 'failed',
    toolsUsed: '',
    filesChanged: '',
    mainText: 'Error: failed\nDetails',
  });
});

test('parseWebSearchOutput extracts answer and result entries', (t) => {
  const output = [
    '## Answer',
    'Use focused tests.',
    '## Search Results',
    '### 1. Docs',
    '**URL:** https://example.com/docs',
    '**Published:** 2026-01-01',
    'Relevant content.',
  ].join('\n');

  t.deepEqual(parseWebSearchOutput(output), {
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

test('parseWebFetchOutput separates table of contents, notes, temp file, and content', (t) => {
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

  t.deepEqual(parseWebFetchOutput(output), {
    title: 'Example',
    url: 'https://example.com',
    toc: '- Intro',
    tempFile: '/tmp/fetch.md',
    notes: '**Note: Content still truncated.**',
    content: 'Body text',
  });
});

test('parseCodeOutlineOutput groups imports exports and declarations', (t) => {
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

  t.deepEqual(parseCodeOutlineOutput(output), {
    filePath: 'source/a.ts',
    lang: 'ts',
    imports: ["import x from 'x';"],
    exports: ['export { y };'],
    decls: ['function y'],
  });
});

test('parseCodeContextSearchOutput parses related file results', (t) => {
  const output = ['QUERY related', 'TARGET source/a.ts', 'source/b.ts', 'REL imports', 'WARNING ignored'].join('\n');

  t.deepEqual(parseCodeContextSearchOutput(output), {
    queryType: 'related',
    target: 'source/a.ts',
    relatedFiles: [{ filePath: 'source/b.ts', relations: 'imports' }],
  });
});

test('parseCodeContextSearchOutput parses symbol results', (t) => {
  const output = ['QUERY symbol', 'SYMBOL run', 'source/a.ts:12 function run exported'].join('\n');

  t.deepEqual(parseCodeContextSearchOutput(output), {
    queryType: 'symbol',
    symbol: 'run',
    results: [{ filePath: 'source/a.ts', lineNum: 12, kind: 'function', name: 'run', exported: true }],
  });
});

test('formatToolArgs parses stringified JSON args', (t) => {
  t.is(formatToolArgs('read_file', '{"path":"source/a.ts","start_line":2,"end_line":4}'), '"source/a.ts" (lines 2-4)');
});

test('formatToolArgs summarizes search replacement batches in concise mode', (t) => {
  t.is(
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
    '"source/a.ts" (+ 1 more)',
  );
});

test('formatToolArgs formats apply patch operation and path', (t) => {
  t.is(formatToolArgs(TOOL_NAME_APPLY_PATCH, { type: 'update_file', path: 'source/a.ts' }), 'update_file source/a.ts');
});

test('countDiffStats ignores diff headers and hunk markers', (t) => {
  t.deepEqual(countDiffStats('--- a/source/a.ts\n+++ b/source/a.ts\n@@ section\n-old\n+new\n context'), {
    added: 1,
    removed: 1,
  });
});
