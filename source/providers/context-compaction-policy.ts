// Pure policy helpers for Responses `context_management`. They live apart from
// openai-responses-model.ts so callers that only need the allowlist or the
// failure classification do not load the OpenAI SDK with it.

/** Shared allowlist for Responses `context_management` (OpenAI + Codex). */
export function supportsContextCompactionModel(model: string): boolean {
  // Server-side context_management is model-dependent: gpt-5.1/gpt-5.2 returned
  // opaque 500s when the threshold fired (docs/plans/openai-context-compaction.md).
  // OpenAI's compaction guide demos gpt-5.3-codex; the compact endpoint enum and
  // product usage cover gpt-5.5 and the full gpt-5.6 family (sol/terra/luna).
  // Default-deny unmeasured families (e.g. bare gpt-5.3, gpt-5.10).
  // Re-measure before adding a new family.
  return /^(?:gpt-5\.(?:4|5|6)(?:$|[-_])|gpt-5\.3-codex(?:$|[-_]))/.test(model);
}

export type ContextCompactionFailureCategory = 'request' | 'validation';

export function contextCompactionFailureCategory(error: unknown): ContextCompactionFailureCategory | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  const status = Number(record.status ?? record.statusCode ?? (record.error as any)?.status);
  const text = JSON.stringify(error);
  // Every branch requires explicit context-management evidence. `server_error` alone is
  // OpenAI's generic 5xx marker and also appears on transport/provider failures that have
  // nothing to do with compaction (e.g. an in-band Codex `server_error` frame on a long
  // chained request). Matching it here misattributes the failure as a compaction failure
  // and, via markContextCompactionFailure, disables compaction for the whole session.
  if (status === 500 && /context[_ ]management/i.test(text)) return 'request';
  if (status === 400 && /unsupported_value/i.test(text) && /context[_ ]management/i.test(text)) return 'request';
  if (status === 400 && /integer_below_min_value|compact_threshold|context[_ ]management/i.test(text))
    return 'validation';
  return undefined;
}
