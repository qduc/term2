/**
 * Coercions for rendering model-supplied tool arguments.
 *
 * `toolArgs` reaches the UI as unvalidated JSON straight from the model. A
 * field the schema declares as an array or a string can arrive as anything —
 * a JSON string, an object, a number — including from a partial stream. Ink
 * renders inside `useMemo`, so an unguarded `.map`/`.split` on such a value
 * throws during render and the error boundary takes down the whole surface,
 * wedging a running session rather than degrading one message.
 *
 * Display code must never assume the declared shape. Coerce here instead.
 */

/** The value if it is genuinely an array, otherwise an empty array. */
export function asDisplayArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * The value if it is a string, otherwise a rendered stand-in. Nullish becomes
 * empty; other non-strings are shown rather than silently dropped, so a
 * malformed payload is visible instead of looking like an empty file.
 */
export function asDisplayString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
