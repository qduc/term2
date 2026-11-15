/**
 * What a `search_replace` call may look like and how its result reads: argument-shape recovery on the way
 * in, batch result wording on the way out. The executor in search-replace.ts owns the state between them.
 *
 * Argument-shape recovery.
 *
 * The advertised shape is `{path, replacements: [{search_content, replace_content, match_all?}]}`.
 * Models regularly send the single-edit form `{path, search_content, replace_content[, match_all]}`
 * instead, and the schema rejected it with "replacements must be array". The flat form is read as one
 * replacement. This is input preprocessing only: the schema presented to the provider is the
 * canonical object schema and never mentions the flat form.
 */

export const FLAT_SEARCH_REPLACE_FIELDS = ['search_content', 'replace_content', 'match_all'] as const;
const FLAT_FIELDS = FLAT_SEARCH_REPLACE_FIELDS;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const MIXED_SHAPE_MESSAGE =
  'send either replacements:[{search_content, replace_content}] or search_content+replace_content at the top level, not both';

export type SearchReplaceShape =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

/** Rewrite flat single-replacement arguments to the array form; reject a call that carries both forms. */
export function normalizeSearchReplaceShape(raw: unknown): SearchReplaceShape {
  if (!isRecord(raw)) return { ok: true, value: raw };
  const flat = FLAT_FIELDS.filter((field) => raw[field] !== undefined);
  if (flat.length === 0) return { ok: true, value: raw };
  if (raw.replacements !== undefined && raw.replacements !== null) return { ok: false, message: MIXED_SHAPE_MESSAGE };
  const { search_content, replace_content, match_all, ...rest } = raw;
  const replacement: Record<string, unknown> = { search_content, replace_content };
  if (match_all !== undefined) replacement.match_all = match_all;
  return { ok: true, value: { ...rest, replacements: [replacement] } };
}

/** Tolerant form for readers that must not throw on a flat call: the rewritten value, or the input unchanged. */
export function readSearchReplaceArguments(raw: unknown): unknown {
  const shaped = normalizeSearchReplaceShape(raw);
  return shaped.ok ? shaped.value : raw;
}

// ---- Result wording for a multi-replacement call ----
// Replacements are numbered from 1 in the order the model sent them, so a failure names which one failed and
// why instead of a row of identical "batch aborted" lines.

export type BatchEntry = Record<string, unknown> & { success: boolean; skipped?: boolean };

/** Entry for a replacement whose search and replace text are identical, left out of a batch. */
export function skippedNoOp(index: number, searchTextPresent: boolean): BatchEntry {
  const why = searchTextPresent
    ? 'search and replace are identical'
    : 'search and replace are identical, and that text does not appear in the file either';
  return { success: true, skipped: true, message: `replacement ${index + 1} skipped: ${why}` };
}

/** A failed replacement's error, labelled with its position when the call held several. */
export function labelFailure(entry: BatchEntry, index: number, total: number): BatchEntry {
  if (total <= 1) return entry;
  return { ...entry, error: `replacement ${index + 1} of ${total}: ${String(entry.error)}` };
}

/**
 * When any replacement of a group failed, nothing is written: rewrite every entry of the group to say so
 * (the failed one keeps its reason, the others name the one that blocked them). A single-replacement call
 * keeps its plain error. Returns whether the group was aborted.
 */
export function abortFailedGroup(
  group: ReadonlyArray<{ operation: { path: string }; index: number }>,
  output: BatchEntry[],
  total: number,
): boolean {
  const failedIndex = group.find(({ index }) => output[index]?.success === false)?.index;
  if (failedIndex === undefined) return false;
  if (total <= 1) return true;
  for (const { operation, index } of group) {
    const failed = output[index]?.success === false;
    output[index] = {
      success: false,
      operation: 'search_replace',
      path: operation.path,
      error: failed
        ? `${String(output[index]!.error)} (batch aborted; no changes were written)`
        : `replacement ${index + 1} not applied: replacement ${failedIndex + 1} failed, so no changes were written.`,
    };
  }
  return true;
}

/** The result text: one line per entry, plus a closing line when every replacement was skipped. */
export function renderBatchResult(output: Array<BatchEntry | undefined>, fallbackPath: string): string {
  const entries = output.filter((entry): entry is BatchEntry => Boolean(entry));
  const lines = entries.map((item) =>
    item.success
      ? String(item.message || `Updated ${String(item.path ?? fallbackPath)}`)
      : `Error: ${String(item.error || 'unknown error').replace(/\n/g, ' ')}`,
  );
  if (entries.length > 0 && entries.every((entry) => entry.skipped)) lines.push('No changes were written.');
  return lines.join('\n');
}
