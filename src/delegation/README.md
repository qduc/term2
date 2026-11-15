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
tool) is treated as possibly writing. A child that cannot write files loses the
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

## Model-facing call shapes

`run_subagent` (`tools/agent/run-subagent.ts`) presents one schema and validates
with a canonical one that first rewrites recoverable mixed shapes
(`run-subagent-shape.ts`): a named `role` sent together with an `agent_spec`,
or agent_spec fields (`doneWhen`, `constraints`, `tools`) at the top level of
a role call. Recorded real-model runs sent these as 48 of 487 first delegation
calls, all naming `explorer`, and every retry but one asked for the named role
with a task. The rewrite is always plain `role` + `task`, so the launch grants
exactly what that role grants on its own. It applies only where dropping the
spec cannot cost the model something it asked for:

| Role | Spec or top-level content | Result |
| --- | --- | --- |
| any writing role (worker, …) | any agent_spec or top-level spec field | reject |
| explorer, librarian | `goal`, `constraints` (strings), `doneWhen`, `context` | append to the task as whole items not already in it |
| explorer, librarian | `tools` / `permissions.tools` within the role's own tools, `budget` (positive `maxTurns`/`maxTokens`), `permissions.readOnly: true`, `permissions.agents.maxDepth` | drop; the role's own tools and limits apply |
| explorer, librarian | `permissions.filesystem`, `permissions.network`, `permissions.agents.create` | reject: a scope the model may rely on for safety, which the role would not enforce |
| explorer, librarian | a tool the role lacks, `model`, any other key (`reasoningEffort`, `provider`, `readOnly`, …), a malformed value | reject |

A writing role is never rewritten because a dropped `filesystem.write` or tool
subset would widen it. Rejections name the single shape to send. When the
launch succeeds, the result carries one `interpretation` line ("Read as role
… with task; …") naming what was appended and what was ignored; a refused or
failed launch carries none. The wrapper is a `z.preprocess` around the
canonical schema, so the canonical JSON Schema stays introspectable. All 48
recorded calls still rewrite under these rules. Presented parameters and
description are unchanged.

## Foreground beside background

A session wired for background delegation also offers `execution:
"foreground"`, but only for `explorer` and `librarian` (named roles, not
`agent_spec`); workers, mentors, reviewers and agent_spec launches stay
background-only and a foreground request for them returns
`foreground_unavailable` without launching. Foreground waits inside the tool
call and returns the formatted result (`Status: …`, final text, tools used) as
that call's result, so the root needs no waiting reply and no notification
turn. Recorded real-model delegations spent about two of four root requests on
that waiting reply and on re-checking the notification.

Until this change foreground was hidden whenever background was wired. No doc
or test records why; the code comment said only that the async capability
"owns the model-facing delegation contract". What that kept true, and how it
is kept now:

- No writing child holds the root turn: the two roles cannot edit files.
- One description per session: the tool definition and prompt are built once
  from the wiring, so the cached prefix does not change mid-session.
- Truthful transfer: when the user moves a foreground child to the background
  (Ctrl+G task manager, `task_control` `background`), `runOrTransfer` returns
  `running` and the tool replies with the ordinary background handle; the same
  child's completion then arrives as a background notification. Before, that
  outcome became a `failed` result although the child kept running. Callers
  that cannot hold a handle (the reviewer's `run_explorer`, mentor consultation,
  `run_code` `agent.run`) get a `failed` result naming the run and saying its
  result arrives as a background notification; before, they got an internal
  "Expected a subagent result" error.
- Resume: a background child's completion notification stays in the history a
  resumed session replays, at the position the live session had it; a child the
  process lost is reported to the model as interrupted with its outcome
  unobserved, never as a result (`src/session/README.md`, "Background notices
  across reopen").
- Approvals: a foreground child's approval is a task interaction the client
  answers (the TUI prompts; headless applies its policy), not an `interrupted`
  result. A background child still cannot ask and fails at such a call.
- Cancellation: the child is linked to the root turn's signal and stops with
  it; a transferred child is detached and survives.

There is no timeout that turns a long foreground wait into a running handle:
headless would wait for a background child anyway, and the TUI user can move
the child to the background. Several foreground calls in one response return
their results in call order but currently run one at a time (see
`docs/plans/tools/parallel-safe-tool-dispatch.md`).

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
