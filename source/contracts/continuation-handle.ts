/**
 * Opaque capability for resuming an in-flight model run.
 *
 * The value owned by the provider/runtime is deliberately kept out of the
 * application contracts. Only the adapter that created the handle can unwrap
 * it, which prevents provider-specific run-state APIs from leaking through the
 * conversation/session layers.
 */
export interface ContinuationHandle {
  readonly kind: 'continuation';
  readonly approve?: (interruption: unknown) => void;
  readonly reject?: (interruption: unknown, options?: { message?: string }) => void;
}

const values = new WeakMap<ContinuationHandle, unknown>();

export function createContinuationHandle(value: unknown): ContinuationHandle {
  const source = value as {
    approve?: (interruption: unknown) => void;
    reject?: (interruption: unknown, options?: { message?: string }) => void;
  } | null;
  const handle = Object.freeze({
    kind: 'continuation' as const,
    ...(typeof source?.approve === 'function'
      ? { approve: (interruption: unknown) => source.approve!(interruption) }
      : {}),
    ...(typeof source?.reject === 'function'
      ? { reject: (interruption: unknown, options?: { message?: string }) => source.reject!(interruption, options) }
      : {}),
  });
  values.set(handle, value);
  return handle;
}

export function unwrapContinuationHandle(handle: ContinuationHandle): unknown {
  if (!handle || handle.kind !== 'continuation' || !values.has(handle)) {
    throw new Error('Invalid continuation handle');
  }
  return values.get(handle);
}
