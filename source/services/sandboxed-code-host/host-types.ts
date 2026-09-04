import type { JsonValue } from '../agent-runtime/workflow/workflow-types.js';

export type { JsonValue };

/**
 * Failure codes the host itself can produce. Capability handlers reuse the same
 * union so a fatal capability outcome and a host failure are indistinguishable
 * to the caller, which is what lets `run_agent_workflow` keep its existing
 * error contract while sharing this engine with `run_code`.
 */
export type HostErrorCode =
  | 'syntax_error'
  | 'runtime_error'
  | 'timeout'
  | 'limit_exceeded'
  | 'approval_required'
  | 'sandbox_unavailable'
  | 'invalid_output'
  | 'code_too_large';

export interface HostError {
  code: HostErrorCode;
  message: string;
}

export type HostResult = { ok: true; output: JsonValue } | { ok: false; error: HostError };

/**
 * How a capability appears to the script.
 *
 * - `factory`: `name(config).run(input)` — the shape `run_agent_workflow` uses.
 * - `namespace`: `name.<member>(params)` — the shape `run_code` uses. A member
 *   speaks an `{ ok, result | error }` envelope: a failed call rejects inside
 *   the script rather than resolving to an error value.
 *
 * Only these two shapes exist, and both live verbatim in the worker template;
 * generating a capability injects its *name* (and member names), never code.
 */
export type CapabilityKind = 'factory' | 'namespace';

/** The generated part of the worker source: names only. */
export type CapabilityBinding =
  | { name: string; kind: 'factory' }
  | { name: string; kind: 'namespace'; members: readonly string[] };

/** A call that passed `prepare` and is waiting to be invoked. */
export interface CapabilityCallContext {
  /** One-based admission order, stable across concurrency. */
  readonly callId: number;
  readonly signal: AbortSignal;
}

/**
 * What a capability does with one call. `result` is delivered to the script;
 * `fail` aborts the whole run with that error, which is how the workflow
 * capability reports a prohibited tool.
 */
export type CapabilityOutcome =
  | { kind: 'result'; result: JsonValue }
  | { kind: 'fail'; code: HostErrorCode; message: string };

export interface CapabilityLimits {
  /** Total calls one run may admit for this capability. */
  maxCalls: number;
  /** How many admitted calls may be in flight at once in the default lane. */
  maxConcurrency: number;
  /** Message used when the budget is exhausted and the run is aborted. */
  limitExceededMessage: string;
}

export interface CapabilityHandler<Prepared = unknown> {
  /** How the capability is bound inside the sandbox. */
  binding: CapabilityBinding;
  limits: CapabilityLimits;
  /**
   * Validates one raw request before it consumes budget or a permit. Returning
   * an outcome short-circuits; returning a value hands it to {@link invoke}.
   */
  prepare(payload: Record<string, unknown>): Promise<Prepared | CapabilityOutcome> | Prepared | CapabilityOutcome;
  /** Called once the call has been admitted and holds a concurrency permit. */
  invoke(prepared: Prepared, context: CapabilityCallContext): Promise<CapabilityOutcome>;
  /** Fires when a call is admitted, before it runs. Used for run bookkeeping. */
  onAdmitted?(prepared: Prepared, context: CapabilityCallContext): void;
  /**
   * Which permit pool the call takes. `serial` is a strict FIFO lane of one,
   * for calls that mutate shared state (the run loop's non-`parallelSafe`
   * rule); `default` is bounded by {@link CapabilityLimits.maxConcurrency}.
   * Omitted means every call is in the default lane.
   */
  lane?(prepared: Prepared): 'serial' | 'default';
  /**
   * What to do with a call that exceeds {@link CapabilityLimits.maxCalls}.
   * Omitting it aborts the run with `limit_exceeded`; a capability that would
   * rather let the script keep the work it has already done returns a result
   * in its own envelope instead.
   */
  overBudget?(): CapabilityOutcome;
}

export interface HostLimits {
  timeoutMs: number;
  maxCodeBytes: number;
  maxOutputBytes: number;
  maxConsoleBytes: number;
}

export interface HostRunInput {
  code: string;
  capabilities: Record<string, CapabilityHandler<any>>;
  limits: HostLimits;
  signal?: AbortSignal;
  /** Noun used in host-generated messages, e.g. 'Workflow' or 'Script'. */
  subject: string;
  /** When set, code that returns nothing completes with `null` rather than failing. */
  allowVoidOutput?: boolean;
  onConsole?: (values: JsonValue[]) => void;
  /** Test seam; defaults to a worker built from `capabilities`. */
  workerFactory?: (code: string, syncTimeoutMs: number) => import('node:worker_threads').Worker;
}

export interface SandboxedCodeHost {
  run(input: HostRunInput): Promise<HostResult>;
}

export function isCapabilityOutcome(value: unknown): value is CapabilityOutcome {
  return (
    typeof value === 'object' &&
    value !== null &&
    ((value as CapabilityOutcome).kind === 'result' || (value as CapabilityOutcome).kind === 'fail')
  );
}
