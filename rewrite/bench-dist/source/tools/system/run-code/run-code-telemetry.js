import { createHash } from 'node:crypto';
/**
 * Structured completion telemetry for one `run_code` invocation.
 *
 * One event per invocation, written through the application logger so it lands
 * in the same durable JSONL app log as every other structured event. It exists
 * to answer the question that gates the type-checked TypeScript slice
 * (docs/plans/tools/run-code/run-code-typescript.md): do statically preventable nested-call
 * failures actually cause retries, false completion, or replay? The answer is
 * derived by querying these events, not by re-reading conversations, so the
 * event carries the join keys (sessionId, sourceDigest, outcome, timestamp) as
 * well as the counts.
 *
 * Emitted at `info`: the default log level is `info`, so the older
 * `run_code execution finished` line, which is `debug`, is absent from default
 * app logs and cannot be counted.
 *
 * Privacy: every emitted value is a number, an enum drawn from a closed set, or
 * a source digest. The script source, its arguments, the failure messages, tool
 * names, workspace paths, and the model-authored `description` are deliberately
 * never emitted — nested failure text routinely carries paths and arguments, and
 * an unknown member name is arbitrary model-authored text. The execution
 * contract supplies the closed diagnostic code before this layer is reached.
 */
export const RUN_CODE_COMPLETION_EVENT = 'tool.run_code.completion';
export const RUN_CODE_COMPLETION_MESSAGE = 'run_code completed';
const SOURCE_DIGEST_CHARS = 16;
/**
 * Stable identity for a script's source, so repetition and replay are visible
 * by joining events instead of storing the source itself.
 */
const digestSource = (code) => createHash('sha256').update(code, 'utf8').digest('hex').slice(0, SOURCE_DIGEST_CHARS);
const NESTED_BUCKET_BY_OUTCOME = {
    ok: 'ok',
    error: 'otherFailures',
    approval_required: 'approvalDenied',
    unknown_policy: 'otherFailures',
    policy_error: 'otherFailures',
    interceptor_denied: 'otherFailures',
    unknown_tool: 'unknownTool',
    invalid_params: 'invalidParams',
    prohibited: 'prohibited',
    describe: 'schemaLookups',
    unknown: 'otherFailures',
};
const summarizeNestedCalls = (calls, terminalDiagnostic) => {
    const counts = {
        calls: 0,
        schemaLookups: 0,
        ok: 0,
        unknownTool: 0,
        invalidParams: 0,
        approvalDenied: 0,
        prohibited: 0,
        otherFailures: 0,
    };
    for (const call of calls) {
        const bucket = NESTED_BUCKET_BY_OUTCOME[call.outcome];
        if (bucket === 'schemaLookups') {
            counts.schemaLookups += 1;
            continue;
        }
        counts.calls += 1;
        counts[bucket] += 1;
    }
    // A rejected name never reaches the ledger, so the terminal diagnostic is the
    // only evidence that one was attempted.
    if (terminalDiagnostic === 'unknown_tool' && counts.unknownTool === 0)
        counts.unknownTool = 1;
    return counts;
};
const summarizeEffectReceipts = (receipts) => {
    const counts = { applied: 0, notApplied: 0, failed: 0, unknown: 0 };
    for (const receipt of receipts) {
        if (receipt.outcome === 'applied')
            counts.applied += 1;
        else if (receipt.outcome === 'not_applied')
            counts.notApplied += 1;
        else if (receipt.outcome === 'failed')
            counts.failed += 1;
        else
            counts.unknown += 1;
    }
    return counts;
};
const classifyDiagnostic = (diagnostic) => {
    switch (diagnostic) {
        case 'syntax':
            return { outcome: 'parse', failureClass: undefined };
        case 'runtime':
            return { outcome: 'runtime' };
        case 'invalid_nested_input':
            return { outcome: 'nested-validation', failureClass: 'parameter-shape' };
        case 'unknown_tool':
            return { outcome: 'nested-validation', failureClass: 'unknown-tool' };
        case 'nested_tool_failure':
            return { outcome: 'nested-validation', failureClass: 'nested-call' };
        case 'approval_denied':
            return { outcome: 'nested-validation', failureClass: 'approval-denied' };
        case 'unhandled_nested_failure':
            return { outcome: 'nested-validation', failureClass: 'nested-call' };
        case 'call_budget':
            return { outcome: 'nested-validation', failureClass: 'budget' };
        case 'invalid_nested_output':
            return { outcome: 'return-serialization' };
        case 'invalid_tool_output':
            return { outcome: 'nested-validation', failureClass: 'known-return-shape' };
        case 'invalid_script_return':
            return { outcome: 'return-serialization' };
        case 'timeout':
            return { outcome: 'timeout' };
        case 'deadline':
            return { outcome: 'timeout' };
        case 'cancellation':
            return { outcome: 'cancelled' };
        case 'oversized_code':
            return { outcome: 'input-rejected' };
        case 'sandbox_unavailable':
            return { outcome: 'host-unavailable' };
    }
};
/**
 * The event's fields. Exported for tests; the emit path below is the only
 * caller in production.
 */
export const buildRunCodeCompletionMeta = (input) => {
    const classification = input.execution.script.status === 'succeeded'
        ? { outcome: 'success' }
        : {
            ...classifyDiagnostic(input.execution.script.diagnostic.code),
            diagnosticCode: input.execution.script.diagnostic.code,
            hostErrorCode: input.execution.hostErrorCode,
        };
    const calls = input.execution.calls;
    const receipts = input.execution.actions;
    return {
        eventType: RUN_CODE_COMPLETION_EVENT,
        // Not imported from run-code.ts: that module imports this one.
        toolName: 'run_code',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        outcome: classification.outcome,
        ...(classification.hostErrorCode ? { hostErrorCode: classification.hostErrorCode } : {}),
        ...(classification.failureClass ? { failureClass: classification.failureClass } : {}),
        ...('diagnosticCode' in classification && classification.diagnosticCode
            ? { diagnosticCode: classification.diagnosticCode }
            : {}),
        durationMs: Math.max(0, Math.round(input.durationMs)),
        timeoutMs: input.timeoutMs,
        sourceBytes: Buffer.byteLength(input.code, 'utf8'),
        sourceLines: input.code.length === 0 ? 0 : input.code.split('\n').length,
        sourceDigest: digestSource(input.code),
        nested: summarizeNestedCalls(calls, classification.diagnosticCode),
        effectReceipts: summarizeEffectReceipts(receipts),
    };
};
/**
 * Record one completion. Telemetry is diagnostic: a failure to build or write
 * the event must never change what the script did or what the caller receives.
 */
export function emitRunCodeCompletionTelemetry(loggingService, input) {
    try {
        loggingService.info(RUN_CODE_COMPLETION_MESSAGE, buildRunCodeCompletionMeta(input));
    }
    catch {
        // Intentionally ignored. See above.
    }
}
//# sourceMappingURL=run-code-telemetry.js.map