import { expect, it } from 'vitest';
import { matchCenteredSnippet } from './text-snippet.js';

it('centers on the earliest source match and keeps surrogate pairs intact', () => {
  const source = `${'a'.repeat(200)}😀 needle ${'b'.repeat(200)}`;
  const snippet = matchCenteredSnippet(source, ['needle'], 40);
  const body = snippet.text.replace(/^…/, '').replace(/…$/, '');

  expect(snippet).toMatchObject({ truncated: true });
  expect(snippet.text).toContain('needle');
  expect(snippet.text.length).toBeLessThanOrEqual(40);
  expect(body.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
  expect(body.charCodeAt(body.length - 1)).not.toBeGreaterThanOrEqual(0xd800);
});

it('uses source positions rather than indexes in a lowercased expansion', () => {
  const source = `${'x'.repeat(100)}İ needle ${'y'.repeat(100)}`;
  const snippet = matchCenteredSnippet(source, ['needle'], 30);

  expect(snippet.text).toContain('needle');
});

it('maps an expansion-only lowercased match to its source character within the UTF-16 cap', () => {
  const source = `${'x'.repeat(500)}İ${'y'.repeat(500)}`;
  const snippet = matchCenteredSnippet(source, ['\u0307'], 240);

  expect(snippet.text).toContain('İ');
  expect(snippet.text.length).toBeLessThanOrEqual(240);
  expect(snippet.truncated).toBe(true);
});
