/**
 * Argument-shape recovery for `search_replace`.
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
