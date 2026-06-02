import test from 'ava';
import { pickPatchOutputItemText, formatPatchOutputItems } from './format-helpers.js';

test('pickPatchOutputItemText: returns error when present', (t) => {
  t.is(pickPatchOutputItemText({ error: 'Invalid patch: bad context' }), 'Invalid patch: bad context');
});

test('pickPatchOutputItemText: prefers error over message and path', (t) => {
  t.is(pickPatchOutputItemText({ error: 'boom', message: 'Updated a.ts', path: 'a.ts' }), 'boom');
});

test('pickPatchOutputItemText: returns message when error absent', (t) => {
  t.is(pickPatchOutputItemText({ message: 'Updated a.ts', path: 'a.ts' }), 'Updated a.ts');
});

test('pickPatchOutputItemText: returns path when only path is set (legacy shape)', (t) => {
  t.is(pickPatchOutputItemText({ success: true, path: 'legacy.ts' }), 'legacy.ts');
});

test('pickPatchOutputItemText: ignores empty strings', (t) => {
  t.is(pickPatchOutputItemText({ error: '', message: 'Updated a.ts', path: 'a.ts' }), 'Updated a.ts');
});

test('pickPatchOutputItemText: returns empty string for non-object input', (t) => {
  t.is(pickPatchOutputItemText(null), '');
  t.is(pickPatchOutputItemText(undefined), '');
  t.is(pickPatchOutputItemText('Updated a.ts'), '');
  t.is(pickPatchOutputItemText(42), '');
});

test('pickPatchOutputItemText: returns empty string when no recognised field is set', (t) => {
  t.is(pickPatchOutputItemText({ success: true }), '');
});

test('formatPatchOutputItems: joins success and error items with newlines preserving order', (t) => {
  const items = [
    { success: true, operation: 'update_file', path: 'a.ts', message: 'Updated a.ts' },
    { success: false, error: 'Invalid patch: bad context' },
  ];
  t.is(formatPatchOutputItems(items), 'Updated a.ts\nInvalid patch: bad context');
});

test('formatPatchOutputItems: returns empty string for non-array input', (t) => {
  t.is(formatPatchOutputItems(null), '');
  t.is(formatPatchOutputItems(undefined), '');
  t.is(formatPatchOutputItems('oops'), '');
  t.is(formatPatchOutputItems({}), '');
});

test('formatPatchOutputItems: returns empty string for empty array', (t) => {
  t.is(formatPatchOutputItems([]), '');
});

test('formatPatchOutputItems: skips items that yield no text', (t) => {
  const items = [
    { success: true, path: 'a.ts', message: 'Updated a.ts' },
    { success: true },
    { success: false, path: 'b.ts', message: 'Created b.ts' },
  ];
  t.is(formatPatchOutputItems(items), 'Updated a.ts\nCreated b.ts');
});
