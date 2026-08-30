import { resolveToolResultMaxBytes } from './bound-tool-result.js';

export type SerializedEnvelope<T> = { value: T; serialized: string; charsUsed: number };

/**
 * Builds a JSON envelope until its `charsUsed` field equals the full serialized
 * envelope length, then admits it only when both output limits accept it.
 */
export function fitSerializedEnvelope<T>(
  build: (charsUsed: number) => T,
  { maxChars, maxBytes = resolveToolResultMaxBytes() }: { maxChars: number; maxBytes?: number },
): SerializedEnvelope<T> | null {
  let charsUsed = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const value = build(charsUsed);
    const serialized = JSON.stringify(value);
    const measured = serialized.length;
    if (charsUsed === measured) {
      if (measured > maxChars || Buffer.byteLength(serialized, 'utf8') > maxBytes) return null;
      return { value, serialized, charsUsed: measured };
    }
    charsUsed = measured;
  }
  throw new Error('Serialized envelope character accounting did not converge.');
}

/**
 * Returns the smallest supported JSON failure that fits both output budgets.
 *
 * Normal tool errors retain their complete `{ error: { code, message } }`
 * shape. Callers use this only after that shape fails. At the 44-byte floor it
 * preserves the public error code without a message. Below that floor no JSON
 * error object is possible, so the one-byte JSON literal `0` is deliberately
 * returned rather than throwing or exceeding the outer cap.
 */
export function boundedJsonFailure({
  maxChars,
  maxBytes = resolveToolResultMaxBytes(),
}: {
  maxChars: number;
  maxBytes?: number;
}): string {
  const minimal = JSON.stringify({ error: { code: 'output_budget_exceeded' } });
  if (fitsSerializedText(minimal, { maxChars, maxBytes })) return minimal;
  return maxChars >= 1 && maxBytes >= 1 ? '0' : '';
}

export function fitsSerializedText(
  serialized: string,
  { maxChars, maxBytes = resolveToolResultMaxBytes() }: { maxChars: number; maxBytes?: number },
): boolean {
  return serialized.length <= maxChars && Buffer.byteLength(serialized, 'utf8') <= maxBytes;
}

/** Returns a UTF-16 slice after moving either boundary inward around a surrogate pair. */
export function safeUtf16Slice(text: string, start: number, end: number): string {
  let safeStart = Math.max(0, Math.min(text.length, start));
  let safeEnd = Math.max(safeStart, Math.min(text.length, end));
  if (safeStart > 0 && isLowSurrogate(text.charCodeAt(safeStart)) && isHighSurrogate(text.charCodeAt(safeStart - 1)))
    safeStart++;
  if (
    safeEnd > 0 &&
    safeEnd < text.length &&
    isHighSurrogate(text.charCodeAt(safeEnd - 1)) &&
    isLowSurrogate(text.charCodeAt(safeEnd))
  )
    safeEnd--;
  safeEnd = Math.max(safeStart, safeEnd);
  return text.slice(safeStart, safeEnd);
}

function isHighSurrogate(value: number) {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number) {
  return value >= 0xdc00 && value <= 0xdfff;
}
