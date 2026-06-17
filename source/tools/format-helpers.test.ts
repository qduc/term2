import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { pickPatchOutputItemText, formatPatchOutputItems } from './format-helpers.js';

it('pickPatchOutputItemText: returns error when present', () => {
  expect(pickPatchOutputItemText({ error: 'Invalid patch: bad context' })).toBe('Invalid patch: bad context');
});

it('pickPatchOutputItemText: prefers error over message and path', () => {
  expect(pickPatchOutputItemText({ error: 'boom', message: 'Updated a.ts', path: 'a.ts' })).toBe('boom');
});

it('pickPatchOutputItemText: returns message when error absent', () => {
  expect(pickPatchOutputItemText({ message: 'Updated a.ts', path: 'a.ts' })).toBe('Updated a.ts');
});

it('pickPatchOutputItemText: returns path when only path is set (legacy shape)', () => {
  expect(pickPatchOutputItemText({ success: true, path: 'legacy.ts' })).toBe('legacy.ts');
});

it('pickPatchOutputItemText: ignores empty strings', () => {
  expect(pickPatchOutputItemText({ error: '', message: 'Updated a.ts', path: 'a.ts' })).toBe('Updated a.ts');
});

it('pickPatchOutputItemText: returns empty string for non-object input', () => {
  expect(pickPatchOutputItemText(null)).toBe('');
  expect(pickPatchOutputItemText(undefined)).toBe('');
  expect(pickPatchOutputItemText('Updated a.ts')).toBe('');
  expect(pickPatchOutputItemText(42)).toBe('');
});

it('pickPatchOutputItemText: returns empty string when no recognised field is set', () => {
  expect(pickPatchOutputItemText({ success: true })).toBe('');
});

it('formatPatchOutputItems: joins success and error items with newlines preserving order', () => {
  const items = [
    { success: true, operation: 'update_file', path: 'a.ts', message: 'Updated a.ts' },
    { success: false, error: 'Invalid patch: bad context' },
  ];
  expect(formatPatchOutputItems(items)).toBe('Updated a.ts\nInvalid patch: bad context');
});

it('formatPatchOutputItems: returns empty string for non-array input', () => {
  expect(formatPatchOutputItems(null)).toBe('');
  expect(formatPatchOutputItems(undefined)).toBe('');
  expect(formatPatchOutputItems('oops')).toBe('');
  expect(formatPatchOutputItems({})).toBe('');
});

it('formatPatchOutputItems: returns empty string for empty array', () => {
  expect(formatPatchOutputItems([])).toBe('');
});

it('formatPatchOutputItems: skips items that yield no text', () => {
  const items = [
    { success: true, path: 'a.ts', message: 'Updated a.ts' },
    { success: true },
    { success: false, path: 'b.ts', message: 'Created b.ts' },
  ];
  expect(formatPatchOutputItems(items)).toBe('Updated a.ts\nCreated b.ts');
});
