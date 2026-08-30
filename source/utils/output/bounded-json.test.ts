import { expect, it } from 'vitest';
import { boundedJsonFailure, fitSerializedEnvelope, safeUtf16Slice } from './bounded-json.js';

it('measures a complete JSON envelope with fixed-point character accounting', () => {
  const fitted = fitSerializedEnvelope((charsUsed) => ({ value: 'quote "\\\n😀', charsUsed }), {
    maxChars: 512,
    maxBytes: 512,
  });

  expect(fitted).not.toBeNull();
  expect(fitted!.value.charsUsed).toBe(JSON.stringify(fitted!.value).length);
  expect(fitted!.serialized).toBe(JSON.stringify(fitted!.value));
  expect(Buffer.byteLength(fitted!.serialized, 'utf8')).toBeLessThanOrEqual(512);
});

it('rejects an envelope that only exceeds after JSON escaping', () => {
  const plain = fitSerializedEnvelope((charsUsed) => ({ value: 'a', charsUsed }), { maxChars: 28, maxBytes: 512 });
  const escaped = fitSerializedEnvelope((charsUsed) => ({ value: '"', charsUsed }), { maxChars: 28, maxBytes: 512 });

  expect(plain).not.toBeNull();
  expect(escaped).toBeNull();
});

it('independently enforces the UTF-8 byte cap', () => {
  const fitted = fitSerializedEnvelope((charsUsed) => ({ value: '😀'.repeat(20), charsUsed }), {
    maxChars: 512,
    maxBytes: 80,
  });

  expect(fitted).toBeNull();
});

it('slices UTF-16 ranges without splitting surrogate pairs', () => {
  expect(safeUtf16Slice('a😀b', 1, 2)).toBe('');
  expect(safeUtf16Slice('a😀b', 1, 3)).toBe('😀');
  expect(safeUtf16Slice('a😀b', 2, 3)).toBe('');
});

it('uses a minimal valid JSON error at its irreducible envelope floor and a JSON literal below it', () => {
  const minimal = JSON.stringify({ error: { code: 'output_budget_exceeded' } });

  expect(boundedJsonFailure({ maxChars: minimal.length, maxBytes: minimal.length })).toBe(minimal);
  // A one-byte runtime cap cannot represent an error object; returning a JSON
  // literal is the only bounded, non-throwing fallback.
  expect(boundedJsonFailure({ maxChars: 1, maxBytes: 1 })).toBe('0');
});
