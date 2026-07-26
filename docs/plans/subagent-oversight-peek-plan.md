# Subagent Oversight — Plan 1: Peek

Status: plan. Implement after this document is accepted, test-first per the `testing` skill.

Parent: `docs/plans/subagent-oversight-goal.md` (feature 2). This plan implements the
**Peek** feature and answers the questions the goal doc requires each plan to answer.

## Why

The orchestrator owns outcomes but is blind mid-run. The only live-state shape is
`SubagentRunHandle` (`source/services/subagents/types.ts:90-97`) — `{runId, role,
status, task}`, nothing else. `get_subagent_result` (`source/tools/agent/run-subagent-
async.ts:183-220`) blocks until completion. Meanwhile `subagent_tool_started` events
(`source/services/subagents/execution-runner.ts:192-201`) carry tool name and arguments
to the UI but never enter the parent's context. The user watches the work while the
orchestrator is blind to it — the exact inversion of single point of contact that the
goal names.

Peek closes the cheapest, most visible gap first: a non-blocking answer to "what is it
doing right now," available at any point during a live run, without spending the
context that delegation exists to save.

## What we are building

A new non-blocking tool `get_subagent_status` the orchestrator can call mid-run, backed
by lightweight per-run progress state captured in the registry. Optional `runId`
returns one run; omitting it returns a compact summary of all live runs.

This is the only surface change. No new events, no streaming, no push into a turn.

## Design decisions (with anchored evidence)

### D1. Poll, not push

A status tool the orchestrator calls when the user asks. Push (progress injected into
the active parent turn) breaks the single-point-of-contact invariant: it interrupts the
orchestrator mid-task and spends the context delegation exists to avoid (goal §2, push
risks: "interrupting the orchestrator mid-task"). Poll never blocks, so it cannot
regress async discipline into a reintroduced blocking wait. This directly answers the
goal's poll-vs-push question.

### D2. Granularity — status + elapsed + last tool + live tool counts

The goal asks whether "status and elapsed time, or last tool plus a progress hint" is
genuinely useful. We ship **both fused**, because the registry can capture them at
near-zero cost. Per-run progress state captured on `subagent_tool_started`:

- `status` (`running`/`completed`/`failed`/`cancelled`)
- `startedAt` ms (new explicit field; `StoredRun` today only has `lastUsedAt`,
  `subagent-async-registry.ts:25-38`)
- `elapsedMs` (derived)
- `lastToolName`, `lastToolAt`
- `toolCounts` live map (the registry version of what the executor already builds at
  `execution-runner.ts:106-123`)

This matches the UI's streaming granularity (the UI already gets `toolName` + count
implied by repeated `subagent_tool_started` events). We do **not** stream tool
*arguments* into parent context — arguments stay in the event flow to the UI only, per
the goal's non-goal ("Streaming subagent tokens or full tool output into parent
context").

### D3. Routing tool-started events into the registry

This is the one wiring subtlety the investigation surfaced and the plan must get right.

Today `subagent_tool_started` is emitted by the executor to the manager's shared
`#onEvent` fan-out — see `source/services/subagents/runtime.ts:60,82,100`, all of which
pass the same `deps.onEvent`. The registry itself only emits `subagent_started` and
`subagent_completed` (`subagent-async-registry.ts:157-164,215,287`); it never sees
`subagent_tool_started`. So the registry's `StoredRun` has no live tool data today.

Lowest-coupling fix: give the registry a self-contained event handler
`handleSubagentEvent(event)` that updates `StoredRun` progress when it sees a
`subagent_tool_started` whose `agentId` is a run it owns (async runs use `agentId ===
runId`). Wire it into the shared fan-out at `runtime.ts` so `subagent_tool_started` is
also handed to `asyncRegistry`. The handler ignores events for runIds it does not own,
so nested/sync subagent events are no-ops. This keeps the registry the single owner of
run lifecycle state and avoids the executor (which is per-execution and holds no
registry reference) needing a back-reference.

`startedAt` is set in `startRun` next to the existing `lastUsedAt: this.#now()`
(`subagent-async-registry.ts:144`).

### D4. One run or all runs

`get_subagent_status` takes an **optional** `runId`. With it: one run's status. Without
it: a compact array of all non-evicted runs (live first), each a single line —
`runId · role · status · taskPreview · lastTool · elapsed`. This directly serves the
"model running several at once" scenario the goal raises and is the natural pre-stage
for the naming scheme Steer will need. Cost is one line per run; the plan caps the
all-runs listing at the configured `sessionCap` (50) so the parent context never grows
unbounded.

### D5. Boundary with `get_subagent_result` — status never returns `finalText`

For a finished run, `get_subagent_status` returns `{status, elapsed, summary, lastTool}`
and explicitly points the orchestrator to `get_subagent_result` for the full report. It
never returns `finalText` or diff evidence. This keeps peek cheap, partitions the two
tools unambiguously, and ensures peek can't duplicate result data into context (the
non-blocking-status-on-a-finished-run overlap the goal flags at §2). `get_subagent_result`
keeps its blocking semantics unchanged.

The only behavior change to `get_subagent_result` in this feature is none. It stays
exactly as is; peek is purely additive.

### D6. Naming — deferred to Steer

Peek's all-runs listing disambiguates with role + task preview, so names are not
load-bearing here. Naming lands with Steer, where addressing genuinely matters. This
keeps peek minimal per "cheapest first."

## Context budget (the binding constraint)

Stated cost per call:

- One run: a single ~6-field object (`~200` tokens worst case).
- All runs: one line per run; at the 50-session cap that is `~50 * 30 ≈ 1500` tokens,
  and only when the orchestrator explicitly asks. The tool description makes clear the
  all-runs form is for "you are running several at once and lost track."

No persistent parent-context cost: status is pulled on demand and not retained. This
satisfies the goal's shared constraint that each plan state and justify its
parent-context cost.

## File-level changes

1. `source/services/subagents/types.ts` — add `SubagentRunStatus` interface
   (`runId, role, status, task, taskPreview, startedAt, elapsedMs, lastToolName,
   lastToolAt, toolCounts`). Leave `SubagentRunHandle` unchanged (it is the launch
   return, intentionally minimal).

2. `source/services/subagents/subagent-async-registry.ts`:
   - Add `startedAt` to `StoredRun`.
   - Add `lastToolName`, `lastToolAt`, live `toolCounts` map to `StoredRun`.
   - Add `handleSubagentEvent(event)` that updates the owning run on
     `subagent_tool_started`.
   - Add `getRunStatus(runId?): SubagentRunStatus | SubagentRunStatus[]` (read-only;
     never blocks, never awaits).
   - Set `startedAt` in `startRun`.

3. `source/services/subagents/runtime.ts` — wrap the shared `onEvent` so
   `subagent_tool_started` (and only that type) is also forwarded to
   `asyncRegistry.handleSubagentEvent`. Keep the existing fan-out to the
   logger/UI unchanged.

4. `source/tools/agent/run-subagent-async.ts` — add `createGetSubagentStatusToolDefinition`
   with a `getSubagentStatus` injection dep (mirroring the existing factory pattern at
   `:138-181`). Optional `runId` zod field. `needsApproval: () => false`. The tool
   executes synchronously (returns a stringified status) — it must never await the run
   promise.

5. `source/agent.ts:227-236` — register `get_subagent_status` alongside
   `run_subagent_async` / `get_subagent_result` in the orchestrator-mode tool set, and
   at `:368-379` for non-lite configs. Add the `getSubagentStatus` dep to
   `getAgentDefinition`.

6. `source/services/subagents/subagent-manager.ts` — expose
   `getRunStatus(runId?)` passthrough to `this.#runtime.asyncRegistry`, and wire the
   `getSubagentStatus` tool dep through the existing bridge (where `runSubagentAsync`
   / `getSubagentResult` are supplied).

7. Prompt updates (prompt text is product behavior, per `AGENTS.md`):
   - `source/prompts/orchestrator.md` — short guidance: use `get_subagent_status` to
     answer a mid-run user question without blocking; it never returns completion
     detail, so call `get_subagent_result` for the real report. Reinforce that peek is
     on-demand, not a substitute for the async completion-notification discipline.
   - Tool description on `get_subagent_status` (in `run-subagent-async.ts`) — pin the
     non-blocking contract and the boundary with `get_subagent_result`.

## TDD plan (tests first)

Per the `testing` skill, tests precede implementation. Relevant existing tests:
`subagent-async-registry.test.ts`, `run-subagent-async.test.ts`,
`orchestrator-prompt.test.ts`.

Registry tests (`subagent-async-registry.test.ts`):
- `getRunStatus` for a running run returns `running` with populated `startedAt`,
  `elapsedMs`, empty `toolCounts` before any tool fires.
- After `handleSubagentEvent({type:'subagent_tool_started', agentId, toolName:'X'})`,
  `getRunStatus` reflects `lastToolName:'X'` and `toolCounts:{X:1}`; a second call
  increments to `{X:2}`.
- `handleSubagentEvent` is a no-op for an `agentId` the registry does not own
  (nested/sync subagent event does not mutate any run).
- `getRunStatus(unknownId)` returns a not-found/evicted sentinel, not a throw (peek
  must not error the orchestrator on a stale id).
- `getRunStatus()` (no id) lists live runs first; finished runs included without
  `finalText`; capped at the session cap.
- Non-blocking invariant: `getRunStatus` returns synchronously even when a run's
  promise is unsettled (assert it does not await the promise).

Tool tests (`run-subagent-async.test.ts`):
- `get_subagent_status` returns a JSON status object for a running run; the executing
  function does not `await` the registry run promise (structural assertion on the
  synchronous return path).
- Optional `runId` omitted yields a multi-run payload.

Prompt tests (`orchestrator-prompt.test.ts`, in the `search-via-shell.test.ts` vein):
- The orchestrator prompt mentions `get_subagent_status` and its non-blocking contract.
- The prompt does not suggest calling peek as a substitute for
  `get_subagent_result` completion evidence.

Async-discipline regression guard (shared constraint, do not regress the rule repeated
in three places): a test asserting `get_subagent_result` still blocks on an unsettled
run while `get_subagent_status` returns immediately.

## Success criteria (mapped to the goal)

- The orchestrator can answer a mid-run user question about a delegated task without
  blocking its own turn — `get_subagent_status` is non-blocking by construction (D1,
  D5; pinned by the regression-guard test).
- At minimum parity with what the UI already streams at summary granularity — tool name
  + count + elapsed (D2).
- The async discipline does not regress — peek is poll-only and never awaits the run
  promise (D1, D5; pinned by regression-guard test).

## Non-goals

- Streaming subagent tokens or full tool output into parent context.
- Returning `finalText` or diff evidence from peek (that is Results' job, feature 1).
- Naming runs (deferred to Steer, feature 3).
- Push notifications / interrupting the orchestrator mid-turn.

## Sequencing and dependencies

Peek is independent of Results and Steer. It pre-stages two things Steer will reuse:
the registry's per-run progress state, and the all-runs listing that makes addressing
by name unnecessary until names actually land. Ship before Results per the goal's
sequencing (Peek → Results → Steer), because it is the cheapest and the one the user
hits directly by asking a question mid-run.