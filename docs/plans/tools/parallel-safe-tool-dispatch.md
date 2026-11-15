# Parallel safe-tool dispatch

Status: **implemented and merged** (`b7eada1e`) in the legacy run loop, where it
never took effect for policy-approved calls (below). In the direct CLI the engine
(`@qduc/agent-core`, `TurnTools.#settle`) groups calls; `approvalFor` in
`src/app/source-tools.ts` decides which calls it may group.

## Direct CLI dispatch

**Defect (found 2026-11-13).** Contiguous parallel-safe calls ran one after the
other at the root and in subagent children, in every approval mode except
`shell.autoApproveMode: always`. With a policy registry attached,
`wrapNeedsApproval` returns `true` for every valid call that no interceptor
refuses, and `approvalFor` marked every policy-approved call
`{ kind: 'none', batched: true }`. The engine stages batched calls in its
approval batch (`turn-tool-batch.ts`) and `readyParallel` never groups one. In
`always` mode `wrapNeedsApproval` returns `false`, the call is unbatched, and
grouping already worked. The flag came from `48284cb7` (2026-11-04, "Decide a
response's tool calls like legacy's approval batch"), which copied legacy: the
legacy loop at `b7eada1e` read the same wrapped `needsApproval` and computed
`parallelSafe` only for calls it returned `false` for, so outside `always` mode
the merged feature was never effective in production either (read from the
code; the legacy loop was not run).

**Fix.** A policy-approved call whose definition is parallel-safe for this input
is now `{ kind: 'none' }`: it is not staged, needs no decision, and may join a
parallel group. `approvalFor` reads `parallelSafe` the way the engine does (only
a literal `true`; a throw means serial). Every other policy-approved call stays
`batched`. Prompts (`ask`), questions, denials, interceptor refusals, YELLOW/RED
shell prompts, the outside-sandbox escape and Docker host control take the same
branches as before; only the auto-approve branch changed.

**Order of one response's calls.** Call the first ask, question or batched
(non-parallel-safe, policy-approved) call the *first staged call*.

1. Calls before the first staged call run before any prompt is shown.
2. Then every staged call is decided, in call order (`runApprovalBatch`).
3. Then the remaining calls run in call order.

In steps 1 and 3, contiguous unstaged parallel-safe calls run together, up to
`agent.maxParallelToolCalls` (default 3; 1 makes everything serial). Every other
call runs alone, and the next call waits until it settles. Results are appended
in call order whatever order the work finishes in, after the whole group settles.

**Behaviour this changed, deliberately.** The batch asks every still-undecided
staged call once per pass and pops one staged call per pass, so a prompt is
asked once more for every staged call after it. Parallel-safe policy-approved
calls are no longer staged, so:

- a prompt followed only by such calls is asked once instead of once per call
  after it (an outside read followed by two workspace reads: 3 prompts before,
  1 after; headless answered the same way each time);
- such calls before the first staged call run before the prompt instead of
  after all prompts are answered;
- when an Escaped question or a stop decision is the first staged call, the turn
  now stops after the response settles; a parallel-safe read before it used to
  hold the last pass and hide the stop (read from `runApprovalBatch`; headless
  offers no question, so this was not run).

Prompt order, the decision applied to each call and the request bodies sent to
the provider are unchanged. If exact prompt counts must be kept, the alternative
is upstream: drop `!batched(plan.approval)` from `readyParallel` in
`agent-runtime/packages/core/src/engine/turn-tools.ts` and revert this change.
Batched calls would then stay staged but be grouped once the batch is decided.

**Which tools this affects.** Every tool that declares `parallelSafe` and that
policy approves without a prompt: `read_file`, `grep`, `glob`,
`read_code_outline`, `code_context_search`, `web_search`, `web_fetch`,
`list_models`, `activate_skill`, `ask_mentor`, `run_explorer`, `get_shell_job`,
`get_subagent_status`, `get_subagent_result` and foreground `run_subagent`. A
reviewer child's `run_explorer` calls therefore start together. MCP tools and
generic `shell` declare nothing and stay serial. `configure_task_check_in`
changes state, so it no longer declares `parallelSafe`: two calls for one target
apply in call order. Any tool that declares `parallelSafe` can now run before a
prompt later in the same response is answered or Escaped, and in a background
child before a later call fails the run for needing approval, so only tools
without side effects should declare it.

**Shared state under concurrency.** Root and child source tools scope their
workspace root, ask-user answer, trim configuration and shell task registry with
`AsyncLocalStorage` (`tool-surface.ts`, `shell-tools.ts`, `output-trim.ts`);
`invalidInputs` and `shellEscapeCwds` are keyed by each call's own input object.
Generic `shell` is not parallel-safe, so the sandbox lease
(`AnthropicShellSandboxRunner.acquire`) is not newly contended by root calls.
`read_file` keeps no read-before-edit or cache state. A `read_file` of a FIFO
blocks a libuv thread and is not abortable: SIGINT then waits for it, on the old
serial path too, and the parallel path can hold up to `maxParallelToolCalls`
of the four default threads.

**Evidence.** `bare-file-tools.blackbox.ts` ("dispatches auto-approved
parallel-safe reads together…") gates FIFO reads: two reads must both be
waiting before either is released, the shell call and the later read must not
start until what precedes them has settled, results must arrive in call order,
and the outside read must be asked once, after the leading reads and before the
shell call. It fails on the pre-fix build at the overlap assertion.

## Resume here (legacy run loop, historical)

The user observed a parent model claiming it was launching parallel explorers,
but provider traffic for session `90021615-6778-485f-9b8f-0faebb25eaa6` showed
two `run_subagent` calls with `execution: "foreground"` being run one after the
other: the first child started at `14:15:34Z`; the second did not start until
the first completed at `14:22:34Z`.

This is current `ApplicationRunLoop` behaviour, not a provider scheduling
failure. `application-run-loop.ts` awaits `#handleToolCall()` for every streamed
tool call, and `#handleToolCall()` awaits `#invokeTool()`. The foreground branch
of `run_subagent` then awaits the nested result. Do not solve this by silently
rewriting foreground calls as background calls: background completion is
delivered on a different notification path and cannot be consumed in the same
parent request boundary.

The existing `ExecutionBudget` already owns child-count and active-concurrency
limits. Parallel dispatch must acquire its normal child slots through the
existing subagent runners; do not add a second concurrency limiter for child
agents. A small dispatcher cap may still be appropriate for independent root
network/read tools.

## Goal

Run independent, auto-approved, read-only tool calls from one model response in
parallel while preserving the model-facing transcript, approval semantics,
cancellation, lifecycle observability, and deterministic result order.

Initial user-visible outcome: two foreground `explorer` calls emitted in one
model response start together (subject to `maxConcurrency`) and their results
are both supplied to the next parent request.

## Decided scope

### Eligible for automatic parallel batches

- `read_file`, `grep`, `glob`, `read_code_outline`, and `code_context_search`
  after their normal workspace/scope preflight succeeds.
- `web_search` and `web_fetch`, with a bounded shared dispatch cap to avoid
  rate-limit bursts.
- `activate_skill`, `ask_mentor`, `get_shell_job`, `get_subagent_status`, and
  `get_subagent_result`.
- Foreground `run_subagent` only for the non-writing `explorer` and
  `librarian` roles, and only when its normal child-budget acquisition accepts
  the run.

### Explicitly serial

- All editors, generic `shell`, worktree changes, `ask_user`, workflow
  execution, and shell-monitor operations.
- Cancellation and steering controls (`cancel_run`, `send_message`,
  `cancel_shell_job`, and `cancel_shell_monitor`).
- Foreground worker subagents. A future worktree-isolation feature may define
  a stronger contract for them; this change does not infer isolation from a
  task prompt.
- Any otherwise read-only call that requests approval. The existing approval
  queue remains the sole owner of its ordering and resolution.

## Invariants

1. Only **contiguous eligible calls** are batched. A serial call is a barrier;
   the dispatcher must not move a later read ahead of a write or context change.
2. The provider transcript always contains function-call items in provider
   order, followed by function-result items in that same order, even when work
   completes out of order.
3. All eligibility checks, scope checks, approvals, abort signals, lifecycle
   callbacks, error normalization, and repeated-failure accounting continue to
   run through the existing run-loop paths exactly once.
4. The request boundary remains after all tool results are recorded. No next
   model request starts while a batch is unfinished.
5. Streamed and terminal-only provider tool calls use one dispatch path; do not
   preserve the current split as two subtly different batching behaviours.

## Implementation plan

1. **Characterize the current boundary before refactoring.**
   Add a focused `ApplicationRunLoop` test through `AgentClient` (not only a
   direct continuation) whose first model response contains two foreground
   explorer-equivalent calls. Use deferred executors to prove the second starts
   before the first settles. Capture the existing ordering of function calls,
   function results, lifecycle events, and the next request input.

2. **Make parallel eligibility an explicit tool capability.**
   Extend the application tool contract with an opt-in, default-serial
   descriptor. Static read-only definitions declare eligibility there;
   `run_subagent` supplies parameter-sensitive eligibility for foreground
   explorer/librarian requests. Preserve the descriptor through scoped tool
   wrappers in `services/subagents/tool-policy.ts`. Do not use a name-only
   allowlist in `ApplicationRunLoop`, because it would bypass role and scope
   policy as new tools are added.

3. **Separate collection from execution at the completed model response.**
   In `ApplicationRunLoop`, collect streamed `tool_call` events until the model
   completion arrives; append terminal-only calls only when the provider did
   not stream them, as today. Then send the unified ordered list through one
   dispatcher. Continue streaming text, reasoning, rate-limit, compaction, and
   tool-argument progress events immediately. This is necessary to know which
   calls form a same-response contiguous batch.

4. **Refactor tool dispatch into ordered registration, preflight, and
   settlement.**
   Register each function call in history/UI before execution. Retain existing
   argument normalization and approval-ledger lookup. Preflight eligibility and
   `needsApproval` in provider order, preserving the existing ability to retain
   later approvals when an earlier call is pending. Dispatch each contiguous
   auto-approved eligible group concurrently; dispatch every other call in
   order. Settle each parallel group with `Promise.all`, normalize failures via
   `#invokeTool`, and append its results in original call order.

5. **Bound independent root I/O without duplicating subagent budgets.**
   Define one conservative root parallel-dispatch cap and make it configurable
   only if the existing settings/limits conventions justify exposing it. Child
   runs continue to rely on `ExecutionBudget.maxConcurrency`; exhaustion must
   surface as the existing subagent result, not a queued hidden retry.

6. **Harden cancellation, approval, and event ordering.**
   Ensure aborting a turn cancels/awaits all started batch members before the
   stream completes; no result may be appended twice. Confirm a serial approval
   barrier neither strands earlier batch work nor lets a later call leap across
   it. Preserve per-call lifecycle hooks and elapsed timing so the UI and
   background-control observers remain truthful.

7. **Update product guidance and observability.**
   Amend the `run_subagent` description/prompt guidance so it says “parallel”
   only for eligible same-response calls. Add concise diagnostics or tracing
   fields for batch ID, eligibility decision, and dispatch/settlement order;
   avoid task text or tool output in logs.

## Verification

- Focused run-loop/`AgentClient` tests:
  - two eligible calls start before either resolves;
  - reverse completion still yields provider-order results;
  - a serial call splits batches and prevents reordering across the barrier;
  - an out-of-scope read requiring approval stays out of a batch;
  - multiple pending approvals retain their existing order;
  - cancellation settles started work without duplicate output;
  - terminal-only and streamed tool-call provider paths produce identical
    transcript ordering.
- Subagent tests: two foreground explorers acquire separate normal budget slots
  and run together when `maxConcurrency >= 2`; `maxConcurrency = 1` retains
  the existing budget-exhausted outcome; workers remain serial.
- Run the focused test files during development, then `pnpm test:provider-black-box`
  (mandatory for run-loop changes), `pnpm typecheck`, and `pnpm build`.
- Establish and report the current main baseline before interpreting any broad
  suite failure as a regression.

## Out of scope

- Parallel writes, automatic worktree creation, changing provider tool-call
  semantics, or changing background-task notification delivery.
- Allowing a parent to consume background subagent results within the same
  tool round.
