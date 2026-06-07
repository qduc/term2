import test from 'ava';

import { classifySearchKind, getMatchCount, parseGrepOutput } from './command-message-helpers.js';

test('getMatchCount returns 0 when output is empty or undefined', (t) => {
  t.is(getMatchCount(undefined, 'grep -rn hello source/', ''), 0);
  t.is(getMatchCount(undefined, 'grep -rn hello source/', undefined), 0);
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
