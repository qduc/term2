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

Tool descriptions are written for the root surface. Before a child's graph is
wrapped, `withoutDeadToolReferences` (`subagents/dead-tool-references.ts`)
deletes whole pointer clauses to the `run_code` script surface from a child
whose final tool list lacks `run_code`, and the shell's pointer to
`run_subagent` from a child that lacks `run_subagent`, so the child is not sent
to a tool it cannot call. It reads the offered tool names, not the role, and
never rewords or redirects; a pointer whose deletion would change the rest of
its sentence stays as written.

`buildInstructions` (`subagents/role-loader.ts`) applies the same rule to the
shared prompt text, again from the offered tool names. Only a tool's absence
counts as proof: an offered editor can still be denied every write (an
agent_spec with `filesystem.write: []`, a read-only session), so no text is
deleted because a tool was offered. A child offered any tool outside a fixed
non-writing set (any editor, `shell`, `run_code`, `run_subagent`, or an unknown
tool) is treated as possibly writing, unless the policy wrapper that built it
refuses every file-changing call and marks it `cannotWriteFiles`: the read-only
shell (`wrapReadOnlyShellTool`, GREEN commands without write targets) that every
non-writing child with `shell` gets, such as an explorer. A child that cannot write files loses the
two Worktree Hygiene worker lines and the "or editing" in its `read_file`
guidance, and, when it has no memory writer either, the skills section's
"perform it with the editing tool" sentence. A child without `ask_orchestrator`
(every foreground child, such as a reviewer's explorer) loses its role file's
"Asking the orchestrator" section, up to the next `#` or `##` heading, except
its "do not contact the user directly", which applies with or without the tool
and is kept as the sentence "Do not contact the user directly.". Text that does
not match is kept.

These deletions run only on Term2-authored text, before it is joined with
anything else: the two fragment files and a named role's role file
(`instructionsSource: 'role-file'`, set only by `loadRoleDefinition`). An
agent_spec child's instructions are its parent's constraints, completion
criterion and context, and are sent exactly as written; project instructions
and the skill catalog are never passed through a pattern either.
`withoutDeadToolReferences` edits tool descriptions only, and every tool a child
can be offered has a Term2-authored description (the child factory builds no MCP
tools); offering a child a tool with external description text would need that
function to skip it.

Filesystem scope checks use the execution context's workspace root, or the
active session root when no execution context is available. The resolver takes
that root explicitly and resolves symlinks before comparing paths, so concurrent
child policies do not share a mutable workspace root.

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

## Shell validation evidence

`subagents/validation-evidence.ts` owns validation-command recognition and the
last captured shell result. It reads exit status only from the shell tool's first
terminal status line and bounds the retained output excerpt. Tool policy supplies
the actual command result and mutable capture holder; it keeps execution,
approval, scope checks, and file-change attribution.

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
