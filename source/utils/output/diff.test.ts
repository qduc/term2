import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { generateDiff } from './diff.js';

it('generateDiff should return correct diff for simple changes', () => {
  const oldText = 'A\nB\nC';
  const newText = 'A\nD\nC';
  const expected = ' A\n-B\n+D\n C';
  const result = generateDiff(oldText, newText);
  expect(result).toBe(expected);
});

it('generateDiff should handle additions', () => {
  const oldText = 'A\nC';
  const newText = 'A\nB\nC';
  const expected = ' A\n+B\n C';
  const result = generateDiff(oldText, newText);
  expect(result).toBe(expected);
});

it('generateDiff should handle deletions', () => {
  const oldText = 'A\nB\nC';
  const newText = 'A\nC';
  const expected = ' A\n-B\n C';
  const result = generateDiff(oldText, newText);
  expect(result).toBe(expected);
});

it('generateDiff should handle completely different texts', () => {
  const oldText = 'A';
  const newText = 'B';
  const expected = '-A\n+B';
  const result = generateDiff(oldText, newText);
  expect(result).toBe(expected);
});

it('generateDiff should handle empty strings', () => {
  const oldText = '';
  const newText = '';
  const expected = ' '; // Both are empty lines, so they match as one empty line?
  // Wait, split('') gives [''] (one empty line).
  // So oldLines=[''], newLines=[''].
  // They match. So ' ' + '' = ' '.
  const result = generateDiff(oldText, newText);
  expect(result).toBe(expected);
});

it('generateDiff should handle multiline changes', () => {
  const oldText = 'line1\nline2\nline3';
  const newText = 'line1\nline2 modified\nline3';
  const expected = ' line1\n-line2\n+line2 modified\n line3';
  const result = generateDiff(oldText, newText);
  expect(result).toBe(expected);
});

it('generateDiff should handle null inputs', () => {
  // @ts-expect-error Testing runtime safety with null
  const result = generateDiff(null, null);
  expect(result).toBe(' '); // Two empty strings produce one matching empty line
});

it('generateDiff should handle undefined inputs', () => {
  // @ts-expect-error Testing runtime safety with undefined
  const result = generateDiff(undefined, 'hello');
  // undefined becomes '' (one empty line), newText is 'hello' (one line)
  // So we're comparing [''] vs ['hello'] - they don't match
  expect(result).toBe('-\n+hello');
});

it('generateDiff should handle undefined oldText', () => {
  // @ts-expect-error Testing runtime safety with undefined
  const result = generateDiff(undefined, undefined);
  expect(result).toBe(' '); // Both undefined become '', matching empty lines
});

it('generateDiff should handle number inputs', () => {
  // @ts-expect-error Testing runtime safety with numbers
  const result = generateDiff(123, 456);
  expect(result).toBe('-123\n+456'); // Numbers get stringified
});

it('generateDiff should handle object inputs', () => {
  // @ts-expect-error Testing runtime safety with objects
  const result = generateDiff({}, { foo: 'bar' });
  // Objects get stringified to '[object Object]' which matches
  expect(result).toBe(' [object Object]');
});

it('generateDiff should handle mixed null and string', () => {
  // @ts-expect-error Testing runtime safety with null
  const result1 = generateDiff(null, 'text');
  expect(result1).toBe('-\n+text');

  // @ts-expect-error Testing runtime safety with null
  const result2 = generateDiff('text', null);
  // 'text' becomes one line, null becomes '' which is one empty line
  expect(result2).toBe('-text\n+');
});
