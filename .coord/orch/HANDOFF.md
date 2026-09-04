# Handoff: shell-inside-vs-outside `run_code` experiment

**Written 2026-09-04, ~22:30 +07.** Everything below is on disk. Read this
before touching `.coord/orch/`, the arm worktrees, or the experiment harness.

Read `.coord/field-test/HANDOFF.md` too — it covers the earlier `run_code`
field test whose lessons this experiment is built on, and its "Traps" section
still applies.

## The question

Is it better for the `shell` tool to be callable only directly (today), only
from inside `run_code` scripts, or both? Three builds exist:

| arm | build path | shell direct | shell in scripts | ships? |
| --- | --- | --- | --- | --- |
| A | `/home/qduc/term2/dist` (main) | yes | no | current behaviour |
| B | `.worktrees/shell-both/dist` | yes | yes | plausible |
| C | `.worktrees/shell-inside/dist` | **no** | yes | **no — see below** |

Arms B and C are one-line changes to `RUN_CODE_PROHIBITED_TOOLS`
(`source/tools/system/run-code/run-code.ts:62`), which governs both script
reachability (`run-code.ts:258` filters the script registry by it) and direct
callability (`isDirectlyCallable`, `run-code.ts:158`). Removing `shell` from
that set makes it script-only, because `shell` declares no
`canRequireApproval`; arm B adds `canRequireApproval: true` to the shell
definition to keep it on the direct surface as well.

**Arm C cannot ship as-is, and the benchmark hides why.** Nested dispatch
denies anything that is not `auto_approve` (`run-code.ts:357`) because a
script cannot prompt. Shell approval is command-dependent, so under normal
settings arm C turns "needs approval" into outright failure. Under the
benchmark's `--auto-approve` everything auto-approves and the problem is
invisible. This is why `shell_nested_denied` is a separate metric — do not
fold it into failures.

## Predictions recorded before running (do not retrofit)

C loses on P and M (a script issuing one command per invocation pays script
tokens for no batching benefit) and wins on F. If that holds, **B is the only
configuration worth shipping**: it adds the fan-out capability without
removing the adaptive path.

## Current state: pilot running

`.coord/orch/exp-shell/pilot.sh` — 9 cells (tasks P, M, F x arms A, B, C, one
rep, `glm` only), serialised. Started ~22:28. Log: `out/pilot.log`; ledger:
`out/runs.tsv`. First cell (P/A) seeded and verified clean.

Estimate 1.5–2.5 h. **Do not run F cells concurrently with anything** — F is
load-sensitive.

### What to check before committing to the full grid

1. Every cell has `seed_verified=yes`.
2. Arm C shows `shell_nested > 0` — proof the nested path is actually
   exercised rather than the model routing around it.
3. `shell_nested_denied` is not silently eating arm C's calls.
4. Arm A's F cell finishes inside budget instead of timing out.

## The three tasks

Definitions in `.coord/orch/deliver/`; prompts the harness feeds agents are
`.coord/orch/exp-shell/tasks/{P,M,F}.txt`.

| task | role | basis | seeded? |
| --- | --- | --- | --- |
| **P** | pure-adaptive endpoint (favours A/B honestly) | real fix `8cb89eba` — background-shell replay ordering | yes, revert |
| **M** | mixed — **carries the verdict** | real fix `f722616a` — transport 500 misattributed as compaction failure | yes, revert |
| **F** | fan-out endpoint (favours B/C honestly) | isolation-risk audit of the 49 files named in `.github/vitest.lane.safe.txt` exclusion comments | no seed (read-only) |

**Why a bracket instead of one task:** measured on arm A, 87% of assistant
messages issue exactly one shell call and only 23% of calls are co-issued —
but that distribution was *produced by* arm A, where scripted shell is
impossible. It may reflect the tool design rather than the work, so it cannot
be used as the target profile. M carries the verdict; P and F only explain the
mechanism.

**Task F v1 was rejected for cost** (`.coord/orch/w3-taskF-v1-rejected.md`):
598 vitest files, arm A estimated 2.5–5 h and expected to time out. Its
analysis is sound and worth reading. v2 keeps 49 targets so arm A finishes in
735–1,470 s of a 2,400 s budget — all three arms comparable.

## Findings that are settled

1. **`run_code` limits, verified in source:** `maxCalls: 200` per script and
   `DEFAULT_TIMEOUT_MS = 120_000`. A B/C solution that issues one nested call
   per target across hundreds of targets **exceeds the call cap** and fails
   mid-run. Without accounting for this we would have measured a cap collision
   and called it a codemode result.
2. **`f722616a` shipped a vacuous regression test.** It throws
   `Object.assign(new Error('server_error'), {status:500})`, but `Error.message`
   is non-enumerable, so the classifier's `JSON.stringify(error)` yields
   `{"status":500}` and never sees `server_error`. **The test passes on the
   buggy tree.** Task M grades leg 1 by a direct
   `contextCompactionFailureCategory` assertion instead. This is also a real
   defect in the product's suite — a regression test that cannot catch its own
   regression — and is worth fixing on its own merits.
3. **Codex model listing degrades and is cached for an hour.** Full diagnosis
   in `deliver/w9-codex-degrade.md`; trap summary in
   `.coord/field-test/HANDOFF.md`. `dispatch.sh` self-heals.

## Harness bugs found and fixed — all silent-wrong-answer class

The harness was built before the pieces it had to connect existed, and every
gap produced plausible numbers rather than errors:

1. **The agent never ran in the seeded worktree.** `run.sh` invoked the CLI
   without changing directory and `non-interactive.ts:336` uses
   `process.cwd()`, so cells would have operated on `.coord/orch/exp-shell/`.
   Seeding would have been irrelevant and models would have edited the
   harness. Fixed: `run.sh:134` wraps the call in `( cd "$WT" && … )`.
2. **`run.sh` never called `seed.sh`.** Tasks M and P would have run against
   already-fixed trees, finding nothing. Fixed with a gate that aborts the
   cell — agent not invoked, no ledger row — if seed or verify fails.
3. **Captured "model work" included the seed diff**, because `work.diff` was
   taken against `base`. Now captured against the seed commit.
4. **Nested shell calls were a static heuristic** (`tools.shell(` occurrences
   in script text). Replaced by real per-call records; see below.
5. **A killed worker left no trace** — `dispatch.sh` only wrote its summary
   line on normal exit, so an OOM-killed worker stalled the orchestrator
   silently. Now traps `INT`/`TERM`/`HUP` and records `killed`.

## Instrumentation

All three arms carry **identical** logging (verified byte-for-byte apart from
each arm's own experiment comment) in `run-code.ts`:

- Enabled only when `TERM2_NESTED_CALL_LOG` is set; otherwise inert.
- One JSON object per line:
  `{"tool","sessionId","timestamp","outcome"}` where outcome is
  `success` | `failure` | `denied-by-approval`.
- `sessionId` comes from `context.context.sessionId` — the same key the
  harness maps provider traffic by.
- Hooks the existing `record(...)` helper; no control-flow change; write
  wrapped in a swallowing `catch`.

Arm A never emits nested records, which is the correct result for it.
`run-code.test.ts:246` uses `it.each([...RUN_CODE_PROHIBITED_TOOLS])`, so arms
B/C legitimately run 55 tests where A runs 57 — no tests were deleted.

## Orchestration

`.coord/orch/dispatch.sh <worker-id> <model-key> <prompt-file>` — one term2
agent per isolated worktree, capturing stdout/stderr, diff, status. Prompts in
`prompts/`, results in `out/`, deliverables collected in `deliver/`.

| key | routing |
| --- | --- |
| `luna` | `-p codex -m gpt-5.6-luna` |
| `glm` | `-p zai -m glm-5.3-flash` |
| `ds` | `-p DeepSeek -m deepseek-v4-flash` (**case-sensitive**) |
| `muse` | `-p opencode -m muse-spark-1.3-contributor` |

**Workers can finish without writing a summary line** if their brief tells
them to write to the main checkout (w8, w10 both did). Always cross-check
`out/<id>.out` and `deliver/` before concluding a worker is still running.

## Sample size — the lesson from E5

Repeats on the earlier field test measured **1.91x** input-token spread and
**3.9x** wall spread within one arm, ~22% CV. E5's headline glm regression
(+69%) **reversed to 0.86x** under 4 runs per arm; it had paired one arm's
worst run against the other's best. **Detecting a 15% effect needs ~8–10 reps
per cell.** Report distributions and the aggregate across pairs; never quote a
single cell. Prefer few cells with many repeats.

## Cleanup owed

14 worker worktrees under `.worktrees/` (`w1-*`…`w11-*`, `task-scout`) plus
the two arm builds (`shell-both`, `shell-inside` — **keep these, the pilot
uses them**). Use `.coord/field-test/archive/` as the pattern: capture
`git diff <merge-base>`, commits, and untracked tarballs before removing.
Per-run worktrees under `exp-shell/worktrees/` and `out/` are gitignored
runtime state.

## Open questions

- **Fan-out amortisation is still undemonstrated** across every round so far.
  Task F is the first task built to test it.
- Whether B's extra capability is worth any measured cost at all, or whether
  the honest answer is "leave it as A".
- The containment fix for the codex cache (last-known-good guard, self-heal on
  no-match, log every network fetch) is recommended in
  `deliver/w9-codex-degrade.md` and **not implemented**.
