/** Private transport marker kept beside the rendered model-visible value. */
export const RUN_CODE_EXECUTION_RESULT = Symbol.for('term2.run_code.execution-result');
export function getRunCodeExecutionResult(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function'))
        return undefined;
    return value[RUN_CODE_EXECUTION_RESULT];
}
export const runCodeExecutionMetadata = (execution) => ({
    success: execution.script.status === 'succeeded',
    ...(execution.script.status === 'failed' ? { diagnosticCode: execution.script.diagnostic.code } : {}),
});
const diagnosticCodeForHostError = (code) => {
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
export function createRunCodeExecution(result, calls, actions, console, attachments = [], 
/**
 * Runtime-observed rejection the host result cannot carry: the script asked
 * about a name that does not exist. It ranks below ledger evidence, because a
 * script may catch the rejection and fail later for another reason.
 */
observedDiagnostic) {
    if (result.ok) {
        return {
            script: { status: 'succeeded', value: result.output, voidOutput: result.voidOutput === true },
            calls,
            actions,
            console,
            attachments,
        };
    }
    const diagnosticCode = result.error.detail === 'invalid_tool_output'
        ? 'invalid_tool_output'
        : result.error.detail === 'unknown_tool'
            ? 'unknown_tool'
            : result.error.code === 'runtime_error'
                ? result.error.detail === 'unhandled_nested_failure'
                    ? 'unhandled_nested_failure'
                    : calls.find((call) => call.diagnostic)?.diagnostic ?? observedDiagnostic ?? 'runtime'
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
//# sourceMappingURL=run-code-execution.js.map