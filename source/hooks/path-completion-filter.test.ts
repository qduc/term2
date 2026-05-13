import test from 'ava';
import { isSubsequenceMatch, filterPathEntries } from './path-completion-filter.js';
import type { PathEntry } from '../services/file-service.js';

const file = (p: string): PathEntry => ({ path: p, type: 'file' });
const dir = (p: string): PathEntry => ({ path: p, type: 'directory' });

test('isSubsequenceMatch - all chars present in order', (t) => {
  t.true(isSubsequenceMatch('meslis', 'MessageList'));
});

test('isSubsequenceMatch - case-insensitive', (t) => {
  t.true(isSubsequenceMatch('MESLIS', 'messagelist'));
  t.true(isSubsequenceMatch('meslis', 'MESSAGELIST'));
});

test('isSubsequenceMatch - exact match', (t) => {
  t.true(isSubsequenceMatch('app', 'app'));
});

test('isSubsequenceMatch - query is prefix', (t) => {
  t.true(isSubsequenceMatch('msg', 'MessageList'));
});

test('isSubsequenceMatch - chars out of order fails', (t) => {
  t.false(isSubsequenceMatch('tsil', 'MessageList'));
});

test('isSubsequenceMatch - query longer than target fails', (t) => {
  t.false(isSubsequenceMatch('messagelists', 'MessageList'));
});

test('isSubsequenceMatch - empty query matches anything', (t) => {
  t.true(isSubsequenceMatch('', 'MessageList'));
});

test('filterPathEntries - returns subsequence matches', (t) => {
  const entries = [file('source/components/MessageList.tsx'), file('source/utils/diff.ts'), file('source/app.tsx')];
  const results = filterPathEntries(entries, 'diff', 12);
  t.true(results.some((e) => e.path.includes('diff')));
});

test('filterPathEntries - returns subsequence matches on basename', (t) => {
  const entries = [file('source/components/MessageList.tsx'), file('source/utils/diff.ts'), file('source/app.tsx')];
  const results = filterPathEntries(entries, 'meslis', 12);
  t.true(results.some((e) => e.path.includes('MessageList')));
});

test('filterPathEntries - excludes entries with no subsequence match', (t) => {
  const entries = [file('source/components/ChatMessage.tsx'), file('source/components/MessageList.tsx')];
  const results = filterPathEntries(entries, 'meslis', 12);
  t.false(results.some((e) => e.path.includes('ChatMessage')));
  t.true(results.some((e) => e.path.includes('MessageList')));
});

test('filterPathEntries - no duplicate entries', (t) => {
  const entries = [file('source/app.tsx'), file('source/components/AppBar.tsx')];
  const results = filterPathEntries(entries, 'app', 12);
  const paths = results.map((e) => e.path);
  t.is(new Set(paths).size, paths.length);
});

test('filterPathEntries - consecutive char run ranks above scattered match', (t) => {
  const entries = [
    file('source/components/MessageList.tsx'), // 'mes' consecutive at start
    file('source/m/hooks/e-selector.ts'), // m,e,s scattered across path
  ];
  const results = filterPathEntries(entries, 'mes', 12);
  t.is(results[0]?.path, 'source/components/MessageList.tsx');
});

test('filterPathEntries - respects max results', (t) => {
  const entries = Array.from({ length: 20 }, (_, i) => file(`source/file${i}.ts`));
  const results = filterPathEntries(entries, '', 5);
  t.is(results.length, 5);
});

test('filterPathEntries - empty query returns first N entries', (t) => {
  const entries = [file('a.ts'), file('b.ts'), file('c.ts')];
  const results = filterPathEntries(entries, '', 10);
  t.is(results.length, 3);
});

test('filterPathEntries - directories rank same as files by score', (t) => {
  // Both 'component' and 'components' match 'comp' — directory scores higher
  // due to boundary bonus on 'comp' in 'components', so directory ranks first
  const entries = [file('source/hooks/component.ts'), dir('source/components')];
  const results = filterPathEntries(entries, 'comp', 12);
  t.is(results[0]?.path, 'source/components');
});

test('filterPathEntries - directories appear when no files match', (t) => {
  const entries = [dir('source/components'), file('source/hooks/unrelated.ts')];
  const results = filterPathEntries(entries, 'comp', 12);
  t.true(results.some((e) => e.path === 'source/components'));
  t.false(results.some((e) => e.path === 'source/hooks/unrelated.ts'));
});

test('filterPathEntries - leaf directory match ranks above full-path-only match', (t) => {
  // Query appears in leaf directory for first entry ("utils"),
  // but only in a non-leaf path segment for second entry.
  const entries = [
    file('source/components/utils/deep-widget.tsx'), // leaf dir match: "utils"
    file('source/utils/components/deep-widget.tsx'), // path-only match: "utils" is non-leaf
  ];
  const results = filterPathEntries(entries, 'utils', 12);
  t.is(results[0]?.path, 'source/components/utils/deep-widget.tsx');
});

test('filterPathEntries - basename match ranks above full-path-only match', (t) => {
  // 'app' appears only in the directory segment for deep-widget.tsx,
  // but in the basename for AppBar.tsx — AppBar should rank higher
  const entries = [
    file('source/app/deep-widget.tsx'), // 'app' only in dir path, basename is 'deep-widget.tsx'
    file('source/components/AppBar.tsx'), // 'app' in basename
  ];
  const results = filterPathEntries(entries, 'app', 12);
  t.is(results[0]?.path, 'source/components/AppBar.tsx');
});
