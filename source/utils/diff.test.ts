import test from 'ava';
import {generateDiff} from './diff.js';

test('generateDiff should return correct diff for simple changes', t => {
    const oldText = 'A\nB\nC';
    const newText = 'A\nD\nC';
    const expected = ' A\n-B\n+D\n C';
    const result = generateDiff(oldText, newText);
    t.is(result, expected);
});

test('generateDiff should handle additions', t => {
    const oldText = 'A\nC';
    const newText = 'A\nB\nC';
    const expected = ' A\n+B\n C';
    const result = generateDiff(oldText, newText);
    t.is(result, expected);
});

test('generateDiff should handle deletions', t => {
    const oldText = 'A\nB\nC';
    const newText = 'A\nC';
    const expected = ' A\n-B\n C';
    const result = generateDiff(oldText, newText);
    t.is(result, expected);
});

test('generateDiff should handle completely different texts', t => {
    const oldText = 'A';
    const newText = 'B';
    const expected = '-A\n+B';
    const result = generateDiff(oldText, newText);
    t.is(result, expected);
});

test('generateDiff should handle empty strings', t => {
    const oldText = '';
    const newText = '';
    const expected = ' '; // Both are empty lines, so they match as one empty line?
    // Wait, split('') gives [''] (one empty line).
    // So oldLines=[''], newLines=[''].
    // They match. So ' ' + '' = ' '.
    const result = generateDiff(oldText, newText);
    t.is(result, expected);
});

test('generateDiff should handle multiline changes', t => {
    const oldText = 'line1\nline2\nline3';
    const newText = 'line1\nline2 modified\nline3';
    const expected = ' line1\n-line2\n+line2 modified\n line3';
    const result = generateDiff(oldText, newText);
    t.is(result, expected);
});
