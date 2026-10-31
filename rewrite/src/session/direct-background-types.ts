/** Session-owned task data. No engine handles, promises or acceptance tokens are facts. */
import type { InteractionRequest, TurnId } from '../engine/index.js';
import type { ModelError, ModelRef } from '../model/index.js';
import type {
  ExecutionId,
  InteractionDecision,
  InteractionRequestId,
  ToolInteractionRequest,
  Workspace,
} from '../tools/index.js';
import type { DirectOrigin } from './facade-types.js';

export type DirectTaskId = string & { readonly __brand: 'DirectTaskId' };
export type DirectTaskMode = 'foreground' | 'background';
export type DirectTaskResult<Value = unknown> =
  | { readonly kind: 'completed'; readonly value: Value }
  | { readonly kind: 'cancelled'; readonly value?: Value }
  | { readonly kind: 'failed'; readonly error: ModelError; readonly value?: Value }
  | { readonly kind: 'interrupted'; readonly reason: string; readonly value?: Value };
export type DirectTaskStatus = 'running' | 'waiting_for_answer' | 'cancelling' | DirectTaskResult['kind'];
export type DirectTaskDescriptor = {
  readonly taskId: DirectTaskId;
  readonly sessionId: string;
  readonly kind: 'shell' | 'subagent';
  readonly label: string;
  /** Original task input, supplied by its launcher; unknown when not supplied. */
  readonly input?: string;
  readonly name?: string;
  readonly role?: string;
  readonly model?: ModelRef;
  readonly workspace?: Workspace;
  readonly parentTurnId: TurnId;
  readonly parentExecutionId?: ExecutionId;
  readonly sourceCallId?: string;
  readonly origin?: DirectOrigin;
  readonly startedAt: number;
};
export type DirectTaskState = DirectTaskDescriptor & {
  readonly mode: DirectTaskMode;
  readonly status: DirectTaskStatus;
  readonly lastActivityAt: number;
  readonly completedAt?: number;
  readonly result?: DirectTaskResult;
  readonly pendingInteractions: readonly DirectTaskInteraction[];
};
export type DirectTaskInteractionInput = ToolInteractionRequest & {
  /** Preserve the engine's request ID when forwarding an engine-owned pause. */
  readonly requestId?: InteractionRequestId;
  readonly turnId?: TurnId;
  readonly executionId?: ExecutionId;
  readonly parentExecutionId?: ExecutionId;
};
export type DirectTaskInteraction = InteractionRequest & {
  readonly taskId: DirectTaskId;
  readonly sessionId: string;
  readonly origin?: DirectOrigin;
};
export type DirectTaskInteractionResolution =
  | { readonly kind: 'decision'; readonly decision: InteractionDecision }
  | { readonly kind: 'cancelled' | 'interrupted' };
export type DirectBackgroundFact =
  | { readonly type: 'task_started'; readonly task: DirectTaskDescriptor; readonly mode: DirectTaskMode }
  | { readonly type: 'task_backgrounded'; readonly taskId: DirectTaskId; readonly at: number }
  | { readonly type: 'task_stop_requested'; readonly taskId: DirectTaskId; readonly at: number }
  | {
      readonly type: 'task_finished';
      readonly taskId: DirectTaskId;
      readonly at: number;
      readonly result: DirectTaskResult;
    }
  | { readonly type: 'task_interaction_opened'; readonly request: DirectTaskInteraction }
  | {
      readonly type: 'task_interaction_closed';
      readonly taskId: DirectTaskId;
      readonly requestId: InteractionRequestId;
      readonly resolution: DirectTaskInteractionResolution;
    };
export type DirectBackgroundProgress = {
  readonly type: 'task_progress';
  readonly taskId: DirectTaskId;
  readonly at: number;
  readonly kind: 'text' | 'tool_progress' | 'activity';
  readonly chunk: string;
  readonly executionId?: ExecutionId;
};
/**
 * Supplied by the owning Session, never a second log. accept must synchronously
 * append/fsync and project before returning; it must not reenter task controls.
 * Publication to observers can be queued by Session. Throwing poisons this live
 * helper: no more admissions, decisions or progress can pass it afterward.
 */
export type DirectBackgroundSink = {
  accept(fact: DirectBackgroundFact): void;
  publish(event: DirectBackgroundProgress): void;
  /** Notify Session to poison its writer and cancel other owned work. Must not throw. */
  failed(error: ModelError): void;
};
export type DirectTaskStart = Omit<DirectTaskDescriptor, 'taskId' | 'sessionId' | 'startedAt'> & {
  readonly mode: DirectTaskMode;
  /** Linked only while foreground-owned; transfer detaches this signal. */
  readonly parentSignal?: AbortSignal;
};
export type DirectTaskContext = {
  readonly task: DirectTaskDescriptor;
  readonly signal: AbortSignal;
  progress(chunk: string, kind?: DirectBackgroundProgress['kind'], executionId?: ExecutionId): void;
  /** No decision reaches the operation until Session has accepted its closure. */
  interact(request: DirectTaskInteractionInput): Promise<InteractionDecision>;
};
export type DirectTaskHandle<Value> = {
  readonly taskId: DirectTaskId;
  /** Settles only after the actual operation/cleanup, never just on abort. */
  readonly result: Promise<DirectTaskResult<Value>>;
};
export type DirectTaskControlResult =
  | { readonly ok: true; readonly task: DirectTaskState }
  | { readonly ok: false; readonly code: 'not_found' | 'not_active' | 'already_background' };

/** A task-local cancellation, not proof that admitted external effects did not happen. */
export function directTaskAbortError(): Error {
  const error = new Error('Task cancellation requested.');
  error.name = 'AbortError';
  return error;
}

/** Normalize host/operation failures without importing a legacy error adapter. */
export function directTaskError(error: unknown): ModelError {
  if (isModelError(error)) return error;
  return { kind: 'provider', message: error instanceof Error ? error.message : String(error), retryable: false };
}

function isModelError(error: unknown): error is ModelError {
  if (!error || typeof error !== 'object') return false;
  const value = error as Partial<ModelError>;
  return (
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean' &&
    [
      'authentication',
      'rate_limit',
      'network',
      'context_overflow',
      'invalid_request',
      'provider',
      'cancelled',
    ].includes(value.kind ?? '')
  );
}
