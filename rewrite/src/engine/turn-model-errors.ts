/** Error projection and backoff for the direct model boundary. */
import type { ModelError } from '../model/index.js';
import type { DirectRecoveryFailure } from './recovery.js';
import { cancelled } from './turn-events.js';

/** Error.message is non-enumerable; raw causes and provider frames never persist. */
export function toModelError(error: unknown): ModelError {
  const { kind, message, retryable, retryAfterMs } = (error ?? {}) as Partial<ModelError>;
  if (typeof kind === 'string' && typeof message === 'string')
    return {
      kind,
      message,
      retryable: retryable === true,
      ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
    };
  return { kind: 'provider', message: error instanceof Error ? error.message : String(error), retryable: false };
}

/** Consume live adapter cause/evidence before the serializable error projection. */
export function recoveryFailure(error: unknown): DirectRecoveryFailure {
  const live = error as { cause?: unknown; recoveryEvidence?: DirectRecoveryFailure['evidence'] } | null;
  return { error: toModelError(error), cause: live?.cause, evidence: live?.recoveryEvidence };
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(cancelled());
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
