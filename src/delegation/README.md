# Delegation public interface

`delegation/` owns session-running agent policy: role loading, model-pool
selection, child capability construction, foreground/background runner state,
retained child sessions, and bounded JavaScript workflow execution. It may use
`session`, `engine`, `tools`, `model`, `config`, and pure `shared` helpers.
Neither tools nor session imports delegation. App supplies concrete adapters;
the protocol layer may consume delegation without reversing that dependency.

## Native executable

`createDirectSubagentTools` (`direct/subagent-tools.ts`) prepares child graphs
and authority snapshots, resolves roles/pools once per spawn, and adapts the
model-facing launcher callbacks to the active `ToolContext.runNested` and task
controls. It returns callbacks, an invocation scope, check-in binding, a
prepared-request authority lookup, and disposal. The authority lookup accepts
only request objects prepared by this instance. App still checks billing and
owns source-definition adaptation, local execution-context construction, and
the bridge from physical invocation to native tool context; these are injected
ports, not imports back into app.

Session owns durable branch/task admission, IDs, accepted history, approvals,
cancellation and completion delivery. `DirectSubagentSessions` retains the
compatibility continuation/shared-role history policy over those accepted
tasks; it does not create a second task lifecycle. Callback projections use
accepted terminal results plus observed tool/diff/validation evidence.

`createRunCodeToolDefinition` (`run-code/run-code-tool.ts`) composes the thin
tool schema/catalogue/presentation with `createRunCodeRuntime`. Registry binding
retains the complete wrapped graph, including script-only tools. The host keeps
approval owners, policy registries and AgentSpec authority; the lower tool
definition sees only the runtime port. `bindRunCodeNestedApprovalOwner` binds
the same live owner to that graph, rather than treating outer script approval as
authority for children. Nested grants, denial, interruption/resume and cancellation
remain in their existing session owners. Script agent launches pass through the
existing permission boundary before resolved launch callbacks are invoked.

`WorkflowEvaluatorImpl` (`workflow/workflow-evaluator.ts`) evaluates one
disposable workflow using the supplied agent runtime, parent tools and limits.
The `run_agent_workflow` leaf receives only its `evaluate` callback. Interactive
approval is still unavailable inside workflows; denied capabilities reject
rather than pausing. Script/workflow time, admission, concurrency, output and
console limits are unchanged by the ownership move.

## Shared result policy

`subagent-result.ts` owns `buildDiffStat` and `truncateResultText` for the
native background callbacks and compatibility execution runner. Keeping these
helpers outside the runner lets both paths share result policy without importing
compatibility execution just to format a result. Tool-facing result types remain
in `tools/subagents/types.ts`.

`buildDiffStat` preserves first-seen file order, deduplicates path strings, and
looks up counts by the literal path before its resolved path; missing counts are
zero. `truncateResultText` preserves text through 40,000 JavaScript string code
units. Longer text retains that prefix and a reference to the complete UTF-8
artifact under `SANDBOX_TEMP_DIR/subagent-result`. Directory creation requests
mode `0700` and is memoized, including a rejected creation promise.

Native background settlement still owns the failed-result empty text and caches
the settled result for notification and retrieval, so those consumers share one
artifact. This module does not own child execution, failure classification or
settlement.

## Compatibility runners

`subagents/subagent-manager.ts` retains its facade API and top-level lifecycle
events. `subagents/runtime.ts` composes nested, one-shot and mentor runners,
the asynchronous registry and the shared role-pool cursor. Do not put prompt,
cache or execution policy back into the facade. `runtime/subagent-bridge.ts`
retains resolved-launch and adopted foreground control. `runtime/` also owns
the adapter from these runners to the lower `AgentRuntime` executor contract.
The application run loop itself stays in engine.

Tool-facing request schemas, results, acknowledgements and continuation-control
ports stay under tools; execution-tree budgets and host-resolved definitions do
not. Session's background notification store lives under `session/session/`,
since it projects and queues accepted lifecycle events. Pool-editor metadata
lives in config; role-to-tier policy lives here.
