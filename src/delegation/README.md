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
native background callbacks. Tool-facing result types remain in
`tools/subagents/types.ts`.

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

## Retained compatibility policy

`runtime/legacy-adapter.ts` adapts stored role definitions to the live AgentSpec
contract. It does not launch a separate runtime. The direct launcher retains role,
tool-policy, role-pool and worker-worktree helpers in `subagents/`; the unused
pre-rewrite bridge, manager and runners were removed in #197.
