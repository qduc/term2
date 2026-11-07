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
