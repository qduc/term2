/** Shared JSON transport values; independent of workflow and sandbox execution. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Validate recursive JSON values, rejecting non-finite numbers and ancestor cycles. */
export function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value as object)) return false;
  ancestors.add(value as object);
  const values = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  const valid = values.every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value as object);
  return valid;
}
