import type { RunCodeDiagnosticCode } from './run-code-execution.js';

/** Terminal semantic outcome of one observed nested action call. */
export type RunCodeActionOutcome = 'applied' | 'not_applied' | 'failed' | 'unknown';

/** Host-observed evidence for one nested action call. */
export interface RunCodeActionReceipt {
  readonly callId: string;
  readonly tool: string;
  readonly outcome: RunCodeActionOutcome;
  readonly reason?: string;
}

/** One tools.* call observed during a runtime invocation. */
export interface RunCodeCallRecord {
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
