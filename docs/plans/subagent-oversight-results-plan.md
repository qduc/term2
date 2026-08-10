# Subagent Oversight — Plan 2: Richer Results

Status: **shipped.** Implemented as the optional `diffStat` and `validation` fields on
`SubagentResult` (`source/services/subagents/types.ts`). Retained for rationale, not as
pending work.

Parent: `docs/plans/subagent-oversight-goal.md` (feature 1). This plan implements the
**Richer subagent results** feature and answers the questions the goal doc requires each
plan to answer.

## Why

`SubagentResult` (`source/services/subagents/types.ts:74-88`) carries `finalText`,
`filesChanged[]`, aggregate `toolsUsed[{toolName, count}]`, optional `usage`, optional
`error`. No diffs, no validation evidence. The orchestrator is required to verify
claims with "changed-file or diff/commit evidence and relevant test output"
(`source/prompts/orchestrator.md:42-44`) but the result gives it none — it re-derives
everything from the filesystem. Report quality depends entirely on the worker's prose
discipline; a worker that does correct work but writes a vague summary degrades the
orchestrator's ability to verify it. We close that by capturing machine-checkable
evidence automatically at result assembly, so verification stops depending on prose.

## What we are building

Two new structured, machine-checkable fields on `SubagentResult`, captured
automatically by the execution machinery — not reported by the worker:

- `diffStat`: per-file added/deleted line counts over `filesChanged`, attributed by
  construction to this run.
- `validation`: `{ command, exitStatus, outputExcerpt }` — the last validation-shaped
  shell command (test/lint/typecheck/build/tsc) the worker ran, its exit status, and a
  truncated excerpt of its output.

`finalText` stays as the narrative layer over the structured evidence.

The capture is **in-memory interception**, not `git diff --stat` at assembly. This is
decided (see D1) and is the binding choice the parent user sign-off pinned.

## Design decisions (with anchored evidence)

### D1. In-memory interception is the attribution spine; git only as a cross-check

The machinery already exists and is attributed by construction. `filesChanged` is
populated by the tool-policy wrapper:

- Write tools (`apply_patch`/`search_replace`/`create_file`, the set
  `MODEL_FACING_EDITOR_TOOLS` at `source/services/subagents/tool-policy.ts:37`) push
  successful write paths via `wrapWriteTool` at `tool-policy.ts:400-406`.
- Shell write commands push recognized paths at `tool-policy.ts:284` and `:322`.

Extending that to carry per-file line counts is an increment on a mechanism that
already works, not a new one.

The decisive argument is **attribution**, not cost. `git diff --stat` reports the
*worktree*, which under parallel workers also contains the orchestrator's own edits,
other workers' edits, and the user's uncommitted work. Reporting those as this
subagent's output would be wrong in exactly the scenario where evidence matters most,
and would collide with the "protect pre-existing user work" clause in
`orchestrator.md`. In-memory interception is attributed by construction, survives
non-git repos, dirty checkouts, and remote execution (`executionContext.isRemote()`)
where git-in-result-assembly would need to run on the far host.

Correctness, not the `AGENTS.md` shell-safety rule, is what makes git-as-primary a
non-starter. (Fixed internal git invocations in result assembly would not violate that
rule — it is about ad-hoc probes with interpolated payloads.)

### D2. The shell-edit hole — measure before building a reconciliation path

Workers have `canRunShell: true` (`source/prompts/subagents/worker.md:8`), so a
shell-driven edit bypasses the editor-tool interceptor entirely and is invisible to
in-memory tracking. The prompt steers workers toward write tools, but that is guidance,
not enforcement. Concretely, `extractPathsFromCommand` (`tool-policy.ts:269,307`) only
captures paths it can parse; shell edits with unrecognized command shapes are not in
`filesChanged` and so are not in `diffStat`.

Mitigation already present in policy: `orchestrator.md` has the parent create an isolated
git worktree and pin the worker via `run_subagent` `worktree` on non-trivial changes,
where git is both accurate and a useful cross-check that catches shell edits. **The plan's
first implementation step is a measurement**: instrument a dev-only counter of how often a
worker shell command results in a filesystem change that is *not* present in
`filesChanged` (compare `git status` before/after around worker shell invocations in a
test fixture). If the rate is negligible, the reconciliation path (git cross-check) is
deferred. If it is material, build a limited git-stat reconciliation that runs only for
worktree-isolated runs and only attributes paths already in `filesChanged` plus any
*new* paths the worker's shell touched within its write boundary. The measurement decides;
the plan does not pre-commit to building reconciliation.

### D3. diffStat shape and capture point

`diffStat: Array<{ path, added, deleted }>` over the deduplicated `filesChanged` (the
executor already dedupes at `execution-runner.ts` result assembly). Capture by extending
the existing write-tool wrappers to record a before/after line delta per successful write
path, stored on `SubagentRunContext` (`tool-policy.ts:39-48`) next to `filesChanged`.
Result assembly (`execution-runner.ts:269-290`) folds the per-file deltas into
`diffStat`. For shell-touched paths outside the editor-tool set, the delta is `null`
(absent) — diffStat is best-effort and the narrative `finalText` is expected to mention
shell-driven structural changes.

We do **not** emit full unified diffs (cost). A small per-file truncated diff is left as
a future enhancement behind the same token budget; this plan ships stat-only.

### D4. validation shape and capture point

`validation?: { command: string; exitStatus: number; outputExcerpt: string }`. Capture
automatically inside the subagent shell-tool wrapper: track the last shell invocation
that matches a validation heuristic (command contains one of `test`, `lint`,
`typecheck`, `tsc`, `build`, `vitest`, `jest`, `npm run`/`pnpm`/`yarn` script with those
names) and has terminated; record its command, exit status, and a truncated (≤2k char)
tail of its output. Store on `SubagentRunContext`; fold into the result at assembly
(`execution-runner.ts:269-290`). If the worker ran no validation command, `validation`
is absent — the orchestrator can then ask the worker to run one, but the field is not
fabricated.

This is the field that makes verification independent of worker prose discipline,
directly satisfying the goal's success criterion: "a worker that does correct work but
writes a vague summary no longer degrades the orchestrator's ability to verify it."

### D5. Token budget and truncation order

Stated budget per result: `~4k` tokens. When exceeded, truncate in this order (highest
cost, lowest value first):

1. Drop any full tool-call trace (we keep none today; this guard is against future
   additions).
2. Truncate per-file diffs to stat-only (already stat-only in this plan; future diffs
   degrade here).
3. Trim `finalText` to a `~1k`-char preview, keeping the structured evidence whole.
4. Keep `validation` and `diffStat` last — highest value, lowest cost.
5. Cap `outputExcerpt` at `2k` chars with a `…(truncated)` marker.

This ordering, and the budget, is pinned by a test that feeds an oversize result and
asserts the truncation sequence.

### D6. Backward compatibility — additive optional fields, no migration

The result persists via `subagent_completed` log events
(`source/services/logging/conversation-log-events.ts:125-145`). The sanitizer
(`conversation-log-writer.ts:74-111`) recursively walks object keys and only strips
`nestedRunResult`; new optional fields persist automatically. Replay
(`conversation-replay.ts:655-701`) currently restores only `status` + `finalText`, so
additive fields do not break replay (restoring them into the replayed message is a
non-goal here). No log envelope version bump is required for additive optional fields.
This answers the goal's back-compat question: yes, the enriched shape stays
backward-compatible for the logging and replay paths.

A test pins that a result with `diffStat` and `validation` round-trips through
`sanitizeSubagentResult` without losing those fields and without `nestedRunResult`.

### D7. worker.md stays as the narrative layer

`worker.md`'s prescribed final report (`source/prompts/subagents/worker.md:39-49`)
stays as the human narrative over machine-checkable evidence. We add a short note that
the validation command is now captured automatically, so the worker should *still* run a
validation command and may state which one, but need not paste its full output. Per
`AGENTS.md`, prompt text is product behavior; a prompt test pins this. The structured
evidence is not redundant with the narrative — the model uses both (see D8).

### D8. Structured fields vs larger free-text — both, layered

The goal asks "which does the model actually use?" Answer: provide both and let the
result formatter (`run-subagent-async.ts:32-56`, `formatSubagentResult`) render a
compact structured block (`Validation: <cmd> → exit N`, `Diff: <path> +A/-D`) *in
addition to* `finalText`. The structured block is what the orchestrator inspects to
verify; `finalText` is what it reads for context. Rendering both answers the question
empirically: the plan ships a prompt test asserting the orchestrator prompt instructs
the agent to check `validation`/`diffStat` before trusting `finalText`. If later
telemetry shows the model ignores the structured block, we collapse to narrative — but
the structured fields are cheap and verification-grade, so we ship both.

## File-level changes

1. `source/services/subagents/types.ts` — add optional `diffStat` and `validation` to
   `SubagentResult`.

2. `source/services/subagents/tool-policy.ts`:
   - Extend `SubagentRunContext` (`:39-48`) with `diffDeltas: Map<string,{added,deleted}>`
     and `lastValidation?: {command, exitStatus, outputExcerpt}`.
   - In `wrapWriteTool` (`:384-411`), after a successful write, compute line delta vs
     the pre-write snapshot and record into `diffDeltas` for the successful path.
   - In the shell wrapper (`wrapWorkerShellTool` `:238-294`, `wrapNestedShellTool`
     `:296-329`), detect validation-shaped commands post-execution and update
     `lastValidation` with command/exit/excerpt.

3. `source/services/subagents/execution-runner.ts`:
   - Pass the enriched context through; at result assembly (`:269-290`) fold
     `diffDeltas` into `diffStat` and attach `lastValidation` as `validation`.
   - Apply the truncation order (D5) via a small `truncateResult` helper.

4. `source/tools/agent/run-subagent-async.ts` — extend `formatSubagentResult`
   (`:32-56`) to render the structured `validation` and `diffStat` block.

5. `source/prompts/subagents/worker.md` — note that validation is auto-captured; still
   run a validation command and state which, but do not paste full output.

6. `source/prompts/orchestrator.md` — short guidance: when verifying a worker report,
   check `validation` (command + exit) and `diffStat` before trusting `finalText`; if
   `validation` is absent, ask the worker to run one.

7. `source/services/logging/conversation-log-writer.ts` — no change required (sanitizer
   is additive); add a test confirming `diffStat`/`validation` survive sanitization.

## TDD plan (tests first)

Measurement test (D2, written and run first):
- A fixture worker run that performs a shell edit *outside* the editor-tool interceptor;
  assert whether the change appears in `filesChanged`/`diffStat`. Document the observed
  rate. This test's *result* drives whether reconciliation is built in this plan or
  deferred.

Tool-policy tests:
- `wrapWriteTool` records a correct `+added/-deleted` delta for a `create_file` and a
  `search_replace`.
- The shell wrapper records `lastValidation` for `npm test`/`vitest`/`tsc` invocations
  with the right exit status and a `≤2k` excerpt; non-validation commands do not
  overwrite a prior `lastValidation`.

Execution-runner tests:
- Result assembly attaches `diffStat` (deduped, paths from `filesChanged`) and
  `validation` from context; both absent when the worker did no writes / no validation.
- `truncateResult` applies the D5 order on an oversize result.

Logging back-compat test:
- A `subagent_completed` log event with `diffStat` + `validation` survives
  `sanitizeSubagentResult`; `nestedRunResult` is stripped; replay maps only
  `status`+`finalText` and does not throw on the new fields.

Prompt tests (`orchestrator-prompt.test.ts`, `worker` prompt test if one exists):
- Orchestrator prompt instructs checking `validation`/`diffStat` before `finalText`.
- `worker.md` notes auto-capture and still requires running a validation command.

Baseline/after validation: run `npm test` (vitest) before and after; fix only
regressions introduced here, leave pre-existing failures alone.

## Success criteria (mapped to the goal)

- For a typical worker run, the orchestrator can satisfy the evidence bar in
  `orchestrator.md` ("changed-file or diff/commit evidence and relevant test output")
  from the result alone — `diffStat` + `validation` (D3, D4).
- A worker that does correct work but writes a vague summary no longer degrades the
  orchestrator's ability to verify it — verification is structurally captured (D4).
- Measured context cost per result stays within the stated `~4k`-token budget (D5).

## Non-goals

- Returning the full transcript or raw tool outputs verbatim.
- Full unified diffs (stat-only this round; truncated diffs are a future enhancement
  behind the same budget).
- Restoring `diffStat`/`validation` into the replayed UI message (log persistence only
  this round).
- git-as-primary attribution (ruled out by D1 on correctness grounds).

## Sequencing and dependencies

Ships after Peek (goal sequencing: Peek → Results → Steer). Depends only on
`SubagentRunContext` and the tool-policy wrappers, which Peek does not touch in a
conflicting way — the two plans edit disjoint fields of `StoredRun`/`SubagentRunContext`
(Peek: live tool counts/lastTool on the registry; Results: diff/validation on the run
context). No cross-feature blocking. The names scheme Steer needs is not required here.