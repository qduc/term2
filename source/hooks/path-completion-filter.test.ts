import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { isSubsequenceMatch, filterPathEntries } from './path-completion-filter.js';
import type { PathEntry } from '../services/file-service.js';

const file = (p: string): PathEntry => ({ path: p, type: 'file' });
const dir = (p: string): PathEntry => ({ path: p, type: 'directory' });

it('isSubsequenceMatch - all chars present in order', () => {
  expect(isSubsequenceMatch('meslis', 'MessageList')).toBe(true);
});

it('isSubsequenceMatch - case-insensitive', () => {
  expect(isSubsequenceMatch('MESLIS', 'messagelist')).toBe(true);
  expect(isSubsequenceMatch('meslis', 'MESSAGELIST')).toBe(true);
});

it('isSubsequenceMatch - exact match', () => {
  expect(isSubsequenceMatch('app', 'app')).toBe(true);
});

it('isSubsequenceMatch - query is prefix', () => {
  expect(isSubsequenceMatch('msg', 'MessageList')).toBe(true);
});

it('isSubsequenceMatch - chars out of order fails', () => {
  expect(isSubsequenceMatch('tsil', 'MessageList')).toBe(false);
});

it('isSubsequenceMatch - query longer than target fails', () => {
  expect(isSubsequenceMatch('messagelists', 'MessageList')).toBe(false);
});

it('isSubsequenceMatch - empty query matches anything', () => {
  expect(isSubsequenceMatch('', 'MessageList')).toBe(true);
});

it('filterPathEntries - returns subsequence matches', () => {
  const entries = [file('source/components/MessageList.tsx'), file('source/utils/diff.ts'), file('source/app.tsx')];
  const results = filterPathEntries(entries, 'diff', 12);
  expect(results.some((e) => e.path.includes('diff'))).toBe(true);
});

it('filterPathEntries - returns subsequence matches on basename', () => {
  const entries = [file('source/components/MessageList.tsx'), file('source/utils/diff.ts'), file('source/app.tsx')];
  const results = filterPathEntries(entries, 'meslis', 12);
  expect(results.some((e) => e.path.includes('MessageList'))).toBe(true);
});

it('filterPathEntries - excludes entries with no subsequence match', () => {
  const entries = [file('source/components/ChatMessage.tsx'), file('source/components/MessageList.tsx')];
  const results = filterPathEntries(entries, 'meslis', 12);
  expect(results.some((e) => e.path.includes('ChatMessage'))).toBe(false);
  expect(results.some((e) => e.path.includes('MessageList'))).toBe(true);
});

it('filterPathEntries - no duplicate entries', () => {
  const entries = [file('source/app.tsx'), file('source/components/AppBar.tsx')];
  const results = filterPathEntries(entries, 'app', 12);
  const paths = results.map((e) => e.path);
  expect(new Set(paths).size).toBe(paths.length);
});

it('filterPathEntries - consecutive char run ranks above scattered match', () => {
  const entries = [
    file('source/components/MessageList.tsx'), // 'mes' consecutive at start
    file('source/m/hooks/e-selector.ts'), // m,e,s scattered across path
  ];
  const results = filterPathEntries(entries, 'mes', 12);
  expect(results[0]?.path).toBe('source/components/MessageList.tsx');
});

it('filterPathEntries - respects max results', () => {
  const entries = Array.from({ length: 20 }, (_, i) => file(`source/file${i}.ts`));
  const results = filterPathEntries(entries, '', 5);
  expect(results.length).toBe(5);
});

it('filterPathEntries - empty query returns first N entries', () => {
  const entries = [file('a.ts'), file('b.ts'), file('c.ts')];
  const results = filterPathEntries(entries, '', 10);
  expect(results.length).toBe(3);
});

it('filterPathEntries - directories rank same as files by score', () => {
  // Both 'component' and 'components' match 'comp' — directory scores higher
  // due to boundary bonus on 'comp' in 'components', so directory ranks first
  const entries = [file('source/hooks/component.ts'), dir('source/components')];
  const results = filterPathEntries(entries, 'comp', 12);
  expect(results[0]?.path).toBe('source/components');
});

it('filterPathEntries - directories appear when no files match', () => {
  const entries = [dir('source/components'), file('source/hooks/unrelated.ts')];
  const results = filterPathEntries(entries, 'comp', 12);
  expect(results.some((e) => e.path === 'source/components')).toBe(true);
  expect(results.some((e) => e.path === 'source/hooks/unrelated.ts')).toBe(false);
});

it('filterPathEntries - leaf directory match ranks above full-path-only match', () => {
  // Query appears in leaf directory for first entry ("utils"),
  // but only in a non-leaf path segment for second entry.
  const entries = [
    file('source/components/utils/deep-widget.tsx'), // leaf dir match: "utils"
    file('source/utils/components/deep-widget.tsx'), // path-only match: "utils" is non-leaf
  ];
  const results = filterPathEntries(entries, 'utils', 12);
  expect(results[0]?.path).toBe('source/components/utils/deep-widget.tsx');
});

it('filterPathEntries - basename match ranks above full-path-only match', () => {
  // 'app' appears only in the directory segment for deep-widget.tsx,
  // but in the basename for AppBar.tsx — AppBar should rank higher
  const entries = [
    file('source/app/deep-widget.tsx'), // 'app' only in dir path, basename is 'deep-widget.tsx'
    file('source/components/AppBar.tsx'), // 'app' in basename
  ];
  const results = filterPathEntries(entries, 'app', 12);
  expect(results[0]?.path).toBe('source/components/AppBar.tsx');
});
