/** Application-owned model failure used for retry classification. */
export class ModelBehaviorError extends Error {
  override name = 'ModelBehaviorError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Accepts legacy provider errors without importing the legacy SDK. */
export function isModelBehaviorError(error: unknown): boolean {
  if (error instanceof ModelBehaviorError) return true;
  const value = error as { name?: unknown; constructor?: { name?: unknown } } | null;
  return value?.name === 'ModelBehaviorError' || value?.constructor?.name === 'ModelBehaviorError';
}
