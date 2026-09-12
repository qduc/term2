import type { HostErrorCode, HostResult } from '../../../services/sandboxed-code-host/host-types.js';
import type { JsonValue } from '../../../services/sandboxed-code-host/host-types.js';

/** Stable, presentation-independent reason for a run_code invocation ending. */
export type RunCodeDiagnosticCode =
  | 'syntax'
  | 'runtime'
  | 'unknown_tool'
  | 'invalid_nested_input'
  | 'invalid_nested_output'
  | 'nested_tool_failure'
  | 'approval_denied'
  | 'unhandled_nested_failure'
  | 'call_budget'
  | 'invalid_script_return'
  | 'timeout'
  | 'deadline'
  | 'cancellation'
  | 'oversized_code'
  | 'sandbox_unavailable';

export interface RunCodeDiagnostic {
  readonly code: RunCodeDiagnosticCode;
  /** Bounded only at the presentation boundary; never emitted as telemetry. */
  readonly message: string;
}

export interface RunCodeExecutionCall {
  readonly callId?: string;
  readonly tool: string;
  readonly outcome:
    | 'ok'
    | 'error'
    | 'approval_required'
    | 'unknown_policy'
    | 'policy_error'
    | 'interceptor_denied'
    | 'unknown_tool'
    | 'invalid_params'
    | 'prohibited'
    | 'describe'
    | 'unknown';
  readonly durationMs: number;
  readonly directlyCallable?: boolean;
  readonly diagnostic?: RunCodeDiagnosticCode;
}

export interface RunCodeExecutionAction {
  readonly callId: string;
  readonly tool: string;
  readonly outcome: 'applied' | 'not_applied' | 'failed' | 'unknown';
  readonly reason?: string;
}

export interface RunCodeAttachment {
  readonly type: 'image' | 'file';
  readonly image?: unknown;
  readonly file?: unknown;
  readonly detail?: unknown;
}

export interface RunCodeExecution {
  readonly script:
    | { readonly status: 'succeeded'; readonly value: JsonValue; readonly voidOutput: boolean }
    | { readonly status: 'failed'; readonly diagnostic: RunCodeDiagnostic };
  readonly calls: readonly RunCodeExecutionCall[];
  readonly actions: readonly RunCodeExecutionAction[];
  readonly console: readonly JsonValue[][];
  readonly attachments: readonly RunCodeAttachment[];
  readonly hostErrorCode?: HostErrorCode;
}

/** Metadata carried beside a persisted tool result, never sent to the model. */
export interface RunCodeExecutionMetadata {
  readonly success: boolean;
  readonly diagnosticCode?: RunCodeDiagnosticCode;
}

/** Private transport marker kept beside the rendered model-visible value. */
export const RUN_CODE_EXECUTION_RESULT = Symbol.for('term2.run_code.execution-result');

export function getRunCodeExecutionResult(value: unknown): RunCodeExecution | undefined {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  return (value as { [RUN_CODE_EXECUTION_RESULT]?: RunCodeExecution })[RUN_CODE_EXECUTION_RESULT];
}

export const runCodeExecutionMetadata = (execution: RunCodeExecution): RunCodeExecutionMetadata => ({
  success: execution.script.status === 'succeeded',
  ...(execution.script.status === 'failed' ? { diagnosticCode: execution.script.diagnostic.code } : {}),
});

const diagnosticCodeForHostError = (code: string): RunCodeDiagnosticCode => {
  switch (code) {
    case 'syntax_error':
      return 'syntax';
    case 'invalid_output':
      return 'invalid_script_return';
    case 'timeout':
      return 'timeout';
    case 'deadline':
      return 'deadline';
    case 'cancelled':
      return 'cancellation';
    case 'code_too_large':
      return 'oversized_code';
    case 'sandbox_unavailable':
      return 'sandbox_unavailable';
    case 'limit_exceeded':
      return 'call_budget';
    case 'approval_required':
      return 'approval_denied';
    default:
      return 'runtime';
  }
};

/** Normalizes host evidence once, below all presentation and logging callers. */
export function createRunCodeExecution(
  result: HostResult,
  calls: readonly RunCodeExecutionCall[],
  actions: readonly RunCodeExecutionAction[],
  console: readonly JsonValue[][],
  attachments: readonly RunCodeAttachment[] = [],
): RunCodeExecution {
  if (result.ok) {
    return {
      script: { status: 'succeeded', value: result.output, voidOutput: result.voidOutput === true },
      calls,
      actions,
      console,
      attachments,
    };
  }

  const diagnosticCode =
    result.error.detail === 'unknown_tool'
      ? 'unknown_tool'
      : result.error.code === 'runtime_error'
      ? result.error.detail === 'unhandled_nested_failure'
        ? 'unhandled_nested_failure'
        : calls.find((call) => call.diagnostic)?.diagnostic ?? 'runtime'
      : diagnosticCodeForHostError(result.error.code);
  return {
    script: {
      status: 'failed',
      diagnostic: { code: diagnosticCode, message: result.error.message },
    },
    calls,
    actions,
    console,
    attachments,
    hostErrorCode: result.error.code,
  };
}
