import test from 'ava';
import { generateDiff } from './diff.js';

test('generateDiff should return correct diff for simple changes', (t) => {
  const oldText = 'A\nB\nC';
  const newText = 'A\nD\nC';
  const expected = ' A\n-B\n+D\n C';
  const result = generateDiff(oldText, newText);
  t.is(result, expected);
});

test('generateDiff should handle additions', (t) => {
  const oldText = 'A\nC';
  const newText = 'A\nB\nC';
  const expected = ' A\n+B\n C';
  const result = generateDiff(oldText, newText);
  t.is(result, expected);
});

test('generateDiff should handle deletions', (t) => {
  const oldText = 'A\nB\nC';
  const newText = 'A\nC';
  const expected = ' A\n-B\n C';
  const result = generateDiff(oldText, newText);
  t.is(result, expected);
});

test('generateDiff should handle completely different texts', (t) => {
  const oldText = 'A';
  const newText = 'B';
  const expected = '-A\n+B';
  const result = generateDiff(oldText, newText);
  t.is(result, expected);
});

test('generateDiff should handle empty strings', (t) => {
  const oldText = '';
  const newText = '';
  const expected = ' '; // Both are empty lines, so they match as one empty line?
  // Wait, split('') gives [''] (one empty line).
  // So oldLines=[''], newLines=[''].
  // They match. So ' ' + '' = ' '.
  const result = generateDiff(oldText, newText);
  t.is(result, expected);
});

test('generateDiff should handle multiline changes', (t) => {
  const oldText = 'line1\nline2\nline3';
  const newText = 'line1\nline2 modified\nline3';
  const expected = ' line1\n-line2\n+line2 modified\n line3';
  const result = generateDiff(oldText, newText);
  t.is(result, expected);
});

test('generateDiff should handle null inputs', (t) => {
  // @ts-expect-error Testing runtime safety with null
  const result = generateDiff(null, null);
  t.is(result, ' '); // Two empty strings produce one matching empty line
});

test('generateDiff should handle undefined inputs', (t) => {
  // @ts-expect-error Testing runtime safety with undefined
  const result = generateDiff(undefined, 'hello');
  // undefined becomes '' (one empty line), newText is 'hello' (one line)
  // So we're comparing [''] vs ['hello'] - they don't match
  t.is(result, '-\n+hello');
});

test('generateDiff should handle undefined oldText', (t) => {
  // @ts-expect-error Testing runtime safety with undefined
  const result = generateDiff(undefined, undefined);
  t.is(result, ' '); // Both undefined become '', matching empty lines
});

test('generateDiff should handle number inputs', (t) => {
  // @ts-expect-error Testing runtime safety with numbers
  const result = generateDiff(123, 456);
  t.is(result, '-123\n+456'); // Numbers get stringified
});

test('generateDiff should handle object inputs', (t) => {
  // @ts-expect-error Testing runtime safety with objects
  const result = generateDiff({}, { foo: 'bar' });
  // Objects get stringified to '[object Object]' which matches
  t.is(result, ' [object Object]');
});

test('generateDiff should handle mixed null and string', (t) => {
  // @ts-expect-error Testing runtime safety with null
  const result1 = generateDiff(null, 'text');
  t.is(result1, '-\n+text');

  // @ts-expect-error Testing runtime safety with null
  const result2 = generateDiff('text', null);
  // 'text' becomes one line, null becomes '' which is one empty line
  t.is(result2, '-text\n+');
});
