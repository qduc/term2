import type { ModelError } from './index.js';

export type ModelRecoveryEvidence =
  | 'request_unsent'
  | 'provider_state_rejected'
  | 'connection_interrupted'
  | 'ambiguous_outcome'
  | 'model_behavior'
  | 'service_tier_rejected'
  | 'transport_downgrade';

/**
 * Engine consumes cause/recoveryEvidence before serializing a terminal error.
 * Both are non-enumerable live evidence, never a persisted retry capability.
 * The cause retains actual typed send/timeout evidence, not a reconstructed Error.
 */
export class ModelFailure extends Error implements ModelError {
  readonly kind: ModelError['kind'];
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  override readonly cause: unknown;
  readonly recoveryEvidence?: ModelRecoveryEvidence;

  constructor(error: ModelError, cause?: unknown, recoveryEvidence?: ModelRecoveryEvidence) {
    super(error.message, { cause });
    this.name = 'ModelFailure';
    this.kind = error.kind;
    this.retryable = error.retryable;
    if (error.retryAfterMs !== undefined) this.retryAfterMs = error.retryAfterMs;
    Object.defineProperty(this, 'cause', { value: cause, enumerable: false });
    Object.defineProperty(this, 'recoveryEvidence', { value: recoveryEvidence, enumerable: false });
  }
}
