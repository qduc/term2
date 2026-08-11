# Parallel safe-tool dispatch

Status: **proposed — awaiting implementation approval**. Nobody is working on it.

## Resume here

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
