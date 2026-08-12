import { it, expect } from 'vitest';
import fs from 'fs';
import { boundToolResultText, looksLikeBinary, truncateToUtf8Bytes, utf8ByteLength } from './bound-tool-result.js';
import { FULL_OUTPUT_SAVED_NOTE_PREFIX } from '../shell/shell-output.js';

it('truncateToUtf8Bytes leaves short text unchanged', () => {
  const result = truncateToUtf8Bytes('hello', 100);
  expect(result).toEqual({ text: 'hello', truncated: false, byteLength: 5 });
});

it('truncateToUtf8Bytes does not split a multibyte character on the cap boundary', () => {
  // "é" is U+00E9 → two UTF-8 bytes C3 A9
  const text = `ab${'é'.repeat(10)}cd`;
  const maxBytes = utf8ByteLength('ab') + 3; // mid multi-byte sequence if naive
  const result = truncateToUtf8Bytes(text, maxBytes);

  expect(result.truncated).toBe(true);
  expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(maxBytes);
  // Must be valid UTF-8 round-trip (no replacement chars from a mid-sequence cut).
  expect(result.text).not.toContain('\uFFFD');
  expect(Buffer.from(result.text, 'utf8').toString('utf8')).toBe(result.text);
});

it('looksLikeBinary detects NUL bytes', () => {
  expect(looksLikeBinary(Buffer.from([0x00, 0x01, 0x02]))).toBe(true);
  expect(looksLikeBinary(Buffer.from('plain text content', 'utf8'))).toBe(false);
});

it('boundToolResultText returns short text unchanged', async () => {
  const result = await boundToolResultText({ fullText: 'small', maxBytes: 1000 });
  expect(result.truncated).toBe(false);
  expect(result.artifactPath).toBeUndefined();
  expect(result.text).toBe('small');
});

it('boundToolResultText spools oversize text with the shell note shape', async () => {
  const fullText = `${'x'.repeat(500)}SENTINEL${'y'.repeat(500)}`;
  const result = await boundToolResultText({ fullText, maxBytes: 200 });

  expect(result.truncated).toBe(true);
  expect(result.artifactPath).toBeTruthy();
  expect(result.text).toContain(FULL_OUTPUT_SAVED_NOTE_PREFIX);
  expect(result.text).toContain('`');
  expect(result.text).not.toContain('SENTINEL');

  const artifact = fs.readFileSync(result.artifactPath!, 'utf8');
  expect(artifact).toContain('SENTINEL');
  expect(artifact).toBe(fullText);
});
