/** The string entries of an array setting, as `toApplicationCodexSettings` keeps them. */
export function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined;
}
