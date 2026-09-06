# Evidence-backed shell timeout improvements

## Resume here

**Closed (2026-09-06): M1 guidance + M2 executor/log observability merged to
main; pilot decision sample complete; M3 decision taken — close, no
escalation.** Milestone 1 is guidance-only (shell tool description,
background-shell addendum, AGENTS.md test policy; defaults and persisted
settings unchanged — no command-name classifier, no renewal API, no
detachment). Milestone 2 added a typed executor termination reason
(`deadline` / `cancelled` / `output-overflow`) with paused-time accounting,
joinable launch/settlement log fields (timeout source, mode, elapsed,
identity), a `cancelled` result presentation distinct from `timeout`, and a
bounded timeout explanation in the tool result. The pilot decision sample
completed: one two-hour controlled watcher run delivered a marker after minute
30 and ran its full explicit horizon unreplaced, and three representative
full-suite runs each reached an actual terminal result within a 900,000 ms
allowance. Explicit finite durations removed the churn; no renewal API is
built and no global default is raised. Full evidence receipt at the end of
this file. Rollback: revert the guidance edits and per-call pilot choices (no
stored settings), or the executor/logging commit alone (no default change).

Owners and prior decisions:

- [Guard ledger](guard-ledger.md): do not repeat broad keyword sweeps. Begin with
  the incidents below; update the relevant ledger rows when implementing.
- [Background shell monitor](background-shell-monitor/MAP.md): preserve output
  watches, terminal notification ordering, bounded retention, and cancellation.
- [Run budgets](run-budget-stall-escalation.md): separate run containment remains
  in force. Shell output is not proof that a process deserves unlimited runtime.

## Evidence and its limits

Investigation coverage: 252,370 structured records in 93 app-log files for
September 1-6, 2026, including retained rotations. This is a snapshot count, not
all-time incidence. Searches of persisted sessions provided supplementary leads;
they were not an exhaustive replay of every tool result. Prompt/source excerpts
and the investigation itself are not runtime incident evidence.

App-log timestamps below are local UTC+7. Artifacts live under
`~/.local/state/term2-nodejs/logs/`. Rotated filenames may change; timestamp,
message, and correlation ID are the stronger lookup keys. Raw logs contain
sensitive payloads: retain only bounded event projections in future receipts.

### E1: repeated receipt-watcher termination and replacement

The scan found 17 records labelled `Shell command timeout` for session-query-index
receipt watchers configured with 1,800,000ms. Do not equate all 17 labels with
independently verified deadline expiry: several lifetimes were shorter. The
following exact 30-minute pairs establish the timeout mechanism directly.

| September 6 start | Timeout | Replacement start | Correlation ID of timed-out invocation |
| --- | --- | --- | --- |
| 00:21:30 | 00:51:30 | 00:51:44 | `76e80290-1009-4820-9bd7-d753feb9b741` |
| 01:33:28 | 02:03:28 | 02:03:35 | `3289ae86-857d-4807-b1d7-048382c1ee23` |
| 02:03:35 | 02:33:35 | 02:33:49 | `a0fa6a19-d9db-4e50-96a0-b6c648bae57b` |
| 02:33:49 | 03:03:49 | 03:03:55 | `4daa24d2-37bd-4394-9948-88e4e59d3da4` |

Sources at investigation time: `term2-2026-09-06.log` and rotations `.1` through
`.5`. These launches invoke `watch-receipts.sh` with the same receipts directory
and persistent `.watch-state`. At 01:33:02 a separate launch attempted a `nohup`
workaround.

Established harm: repeated replacement work and gaps in live monitoring.
Not established: permanently missed receipts or lost worker results. The
persistent baseline is intended to detect changes across restarts; verify that
property rather than claiming continuous delivery.

### E2: validation interrupted at the shell runtime limit

In `term2-2026-09-05.log.1`, correlation
`ab9fd1ec-ed0b-4249-ba0b-dca93c6a77d3`:

- 09:54:46: `pnpm test` starts with timeout 120,000ms.
- 09:56:46: `Shell command timeout`; settlement has `successCount: 0` and
  `timeoutCount: 1`.
- 09:57:33: a narrower test selection starts.

Additional 120,000ms timeout records: September 5 at 00:37:26 for the full suite
with a tail pipe, September 5 at 14:40:34 for the nested-approval full-suite
capture command, September 6 at 08:46:55 for related tests, and September 6 at
11:10:05 for the full suite.

Established harm: intended validation runs were interrupted and did not return
complete validation evidence. The first sequence includes subsequent validation
work. Not established: every timed-out test process was healthy rather than hung,
or that a particular larger default would have completed them.

### Exclusions: no behavior changes supported by this investigation

- Foreground output-buffer kill, three-continuation steering ceiling, five-minute
  non-interactive background drain, and blocking uncached-input warning: no
  runtime harm incident established. Keep these out of the implementation queue.
- Tool-argument cap: 13 failure records (12 Luna, one GLM) establish trips, not
  false positives. The two sized records were 113,957 and 100,013 characters
  against 100,000. Legitimate oversized work was not established; Luna has an
  observed runaway class. Do not raise or remove this cap from these counts.
- The stale recovery-episode clock and repetition-only aborts were repaired
  previously. They are not new work in this plan.

## Current contract, verified in code

`ShellSettingsSchema` in `source/services/settings/settings-schema.ts` declares
120,000ms foreground and 1,800,000ms background defaults. In
`source/tools/system/shell.ts`, the `timeoutValue` resolution selects an explicit
`timeout_ms` before the foreground/background setting, then passes it through
`executePreparedCommand` to `executeShellCommand`.

`startCommandTimeout` in `source/utils/shell/execute-shell.ts` latches timeout and
begins process termination on expiry. Its network-approval pause/resume behavior
is separate and must be preserved. `BackgroundShellRegistry` owns job lifecycle,
not timeout policy. The background-shell prompt addendum describes notification
waiting but does not currently teach timeout selection for long-lived watchers.

Thirty minutes is a background default, not a verified immutable maximum. Logs
also contain configured durations exceeding two hours. Ordinary stdout must not
reset a total runtime limit. Do not use detachment to escape registry ownership.

## Milestone 1: use the existing controls and measure the result

Objective: remove avoidable restart/interruption churn without changing runtime
semantics, defaults, or persisted settings.

1. Identify the maintained launch instructions for the affected receipt watcher
   and validation workflow. Inspect the live runtime script before changing its
   instructions; it is outside the repository and is not modified by this plan.
2. Teach the shell tool description/background-shell addendum and relevant
   testing guidance to select an explicit finite timeout for known long work.
   Reuse existing surfaces; do not add a command-name classifier for `pnpm test`.
3. For the pilot, use a two-hour watcher horizon and a 15-minute full-suite
   validation allowance. These are provisional per-invocation experiment values,
   not measured safe defaults or guarantees of completion. Choose different
   finite values when known job duration or an explicit user limit requires it.
4. Attach the existing monitor in the launch call when notifications are needed.
   For long validation, use the existing background lifecycle when appropriate;
   do not replace completion notifications with polling. Preserve full output
   references and do not count a narrowed rerun as a completed full-suite gate.
5. Retain the persistent watcher baseline across deliberate restarts. Stop an old
   watcher through its owning registry before replacing it when needed; do not
   introduce overlapping writers to the same baseline. No `nohup`/detachment fix.

Acceptance: a controlled watcher emits and delivers a marker after minute 30
without replacement, and a deliberately ended/restarted watcher detects a marker
created during the gap. At least one representative full-suite validation ends
with an actual terminal test result within the pilot allowance. A failure or
continued hang is evidence to diagnose, not permission for automatic extension.
Record completion status separately from whether tests pass.

Rollback: revert the guidance changes and per-call pilot choices. No stored
setting needs migration. A failed pilot must retain its actual elapsed time,
termination reason, and available output rather than silently retrying.

## Milestone 2: make timeout evidence actionable

Objective: distinguish a deliberate deadline, cancellation, and other process
termination, and make the effective budget visible without reading raw prompts.

At the shell execution owner, first inventory existing launch/settlement fields
and add only missing information: timeout source (invocation/foreground setting/
background setting), effective milliseconds, execution mode, elapsed and paused
time, correlation/call/job identity where available, and typed termination
reason. Deadline metadata belongs to the executor; do not infer it merely from
a SIGTERM. The shorter E1 lifetimes are an investigation lead, not a confirmed
misclassification defect.

Show a bounded timeout explanation in the tool result and retain existing partial
output/artifact references. State that effects may be partial and that increasing
the limit does not authorize replay. Do not log command bodies, environment
values, or tool payloads as new observability fields.

Acceptance: an investigator can join launch and settlement, identify the source
and exact deadline outcome, and distinguish cancellation without examining
provider request bodies. Each code-level classification change requires a
reproduction through the public shell boundary before implementation.

Rollback: independent diagnostics/settlement commit, with no default change and
no changes to unrelated job or provider recovery ownership.

## Milestone 3: conditional escalation, not a preapproved feature

After the pilot, compare deadline interruptions, watcher restarts, supervision
gaps, and validation completion across equivalent workloads. Initial decision
sample: one two-hour controlled watcher run and three representative full-suite
runs, retaining individual outcomes rather than extrapolating a population rate.

- If explicit finite durations remove the churn, close this plan. Do not build
  a renewal API or raise global defaults.
- If owned watchers repeatedly need to outlive a correctly selected finite
  horizon, propose a separate explicit renewal contract. It must identify the
  authorized caller, finite grant, live-job identity, deadline race behavior,
  notification ordering, cancellation, and rollback. No automatic renewal from
  stdout or heartbeat activity.
- If validation still overruns, diagnose its duration/hang before adjusting a
  budget. Evidence of a slow test suite is not evidence for removing containment.

## Guard contracts and validation obligations

Both E1 and E2 concern total-runtime containment, not inactivity detection.
Harm prevented remains unbounded process lifetime. Legitimate watchers and long
validation can produce the same elapsed-time signal. Enforcement stays in the
shell executor, recovery remains an explicit caller decision, and sibling jobs
must not be terminated. No provider replay, sandbox weakening, global default
change, or persisted-value rewrite is proposed.

Before production edits, load the testing skill and run the smallest relevant
baseline in an isolated worktree. Add deterministic public-boundary coverage for
explicit/default timeout precedence, legitimate work beyond the old defaults,
actual finite expiry, deadline minus one/at/plus one, cancellation, network
approval pause/resume, partial output, monitor settlement ordering, and sibling
isolation as applicable to the changed seam. Use fake time/processes for long
intervals; the live pilot is separate evidence, not a long-running unit test.

Prompt edits are product behavior: validate prompt construction and exercise the
resulting timeout choices in the pilot. Run focused shell/executor/monitor tests,
typecheck, and changed-file formatting for runtime changes. Provider/run-loop or
non-interactive changes, if later needed, additionally require the provider
black-box gate and their owning plans; they are not currently in scope. Complete
the testing skill broader gate for the actual blast radius before handoff.

Close with an evidence receipt: red proof where behavior changed, final check
results, effective pilot values, workload outcomes, remaining uncertainties,
rollback boundary, and merged commit references. Update the guard ledger with
those receipts rather than promoting theoretical candidates to confirmed harm.

## Evidence receipt (2026-09-06, local UTC+7) — plan closed

Pilot directory: `/tmp/qduc/term2-nodejs/et-watch-pilot-zXIZRz` (acceptance 1),
`/tmp/qduc/term2-nodejs/et-gap-pilot-haalVp` (acceptance 2). All jobs ran the
live runtime watcher `~/.agents/runtime/session-query-index/watch-receipts.sh`
(sha256-line emission against a persistent `.watch-state` baseline; 45 s poll).

1. **Acceptance 1 — MET** (controlled watcher delivers a marker after minute 30,
   no replacement). Marker writer job `32927340` (`sleep 1860` + write +
   `MARKER-WRITTEN`, explicit `timeout_ms` 2,000,000) started 13:22:46, wrote
   `receipts/pilot-marker.md` at 13:53:46, runtime 1,860,012 ms, exit 0.
   Watcher job `de6e0f6d` (explicit `timeout_ms` 7,200,000 = two-hour horizon)
   started 13:22:46, single instance throughout (same PIDs 3243731/3243732, no
   second launch), emitted `4599d5fb…e42 pilot-marker.md` on its poll after the
   write; `sha256sum` matched exactly. Watcher continues to ~15:22:46 to finish
   the two-hour M3 decision-sample run (its terminal settlement will be a typed
   `timed_out` at the explicit horizon — the designed outcome).
2. **Red proof of the E1 mechanism (failed first attempt, 2026-09-06 ~12:49):**
   jobs `5d7470b9` (31-min marker writer) and `1e9f0a2c` (watcher) were launched
   WITHOUT an explicit `timeout_ms`; both were terminated by the 1,800,000 ms
   background default at 30:00 (settlement typed `timed_out`), the marker ~53 s
   before it would have been written, the watcher dead before the marker existed.
   No delivery. Omitting the explicit budget reproduced the E1 30-minute
   replacement churn exactly; applying M1 item 3 (two-hour horizon + explicit
   finite budget) then passed.
3. **Acceptance 2 — MET** (deliberately ended/restarted watcher detects a marker
   created during the gap). Watcher G1 job `e711b8fe` (3,600,000 ms horizon)
   launched 13:55:03 on the fresh gap baseline, cancelled deliberately through
   its owning registry at ~13:55:10 → settlement status `cancelled`, runtime
   7,051 ms. `receipts/gap-marker.md` written 13:55:32 with zero watchers alive.
   Restarted watcher G2 job `e21ec1a3` (same baseline) launched 13:55:39; its
   startup arm emitted `a4e11847…bf7 gap-marker.md`; `sha256sum` matched. G2
   cancelled after delivery (runtime 15,310 ms; job output retains the emission).
4. **Full-suite gate (M3 decision sample, run 1 of 3):** job `4332df08`
   (`pnpm test`, worktree) started 13:55:03, explicit 900,000 ms allowance.
   Terminal result at 144,987 ms (process exit 1): Test Files 3 failed | 612
   passed | 1 skipped (616); Tests 5 failed | 8079 passed | 3 expected fail | 2
   skipped (8089). Completed within the allowance with an actual terminal
   result. The 5 failures are pre-existing in this environment, not M1/M2
   regressions: 4 are the known nested-TMPDIR needsApproval class
   (apply-patch.test.ts ×2, search-replace.test.ts ×2 — reproduce on pristine
   main); the 5th (scripted-adapter.acceptance.test.ts "drives one real session
   turn…", empty `seen`) reproduces identically on main's pre-M2 code in this
   environment (74 ms, same assertion).
5. **Full-suite gate, run 2 of 3:** job `17ef89c8`, started 13:58:42, terminal
   result at 132,839 ms (exit 1): same 3 files / 5 tests failed (identical
   pre-existing set), 8079 passed. Completed within the allowance.
6. **Full-suite gate, run 3 of 3:** job `d73fae9e`, terminal result at
   132,176 ms wall (Duration 130.43 s, exit 1): same 3 files / 5 tests failed
   (identical pre-existing set), 8079 passed. Completed within the allowance.
   **M3 full-suite leg complete: 3/3 representative runs reached an actual
   terminal test result within the 900,000 ms allowance (144,987 / 132,839 /
   ~132,000 ms); no interruption, no hang, no renewal needed.** The single
   remaining M3 sample leg is the two-hour watcher run (job `de6e0f6d`,
   started 13:22:46, horizon 7,200,000 ms, expected typed `timed_out`
   settlement ~15:22:46 — the designed terminal outcome).
7. **Two-hour watcher leg — complete:** job `de6e0f6d` settled at 15:22:46
   with typed `timed_out`, Runtime 7,200,009 ms — exactly its explicit
   7,200,000 ms horizon. Single instance throughout (same PIDs 3243731/3243732
   from 13:22:46 to settlement); output retains the 13:54 marker delivery line.
   The watcher survived past the 30-minute default, delivered the post-minute-30
   marker, and ran its full chosen horizon unreplaced.
8. **M3 decision — close the plan, no escalation.** Decision sample complete:
   one two-hour controlled watcher run (above) and three representative
   full-suite runs (items 4–6), each reaching an actual terminal result within
   its explicit 900,000 ms allowance. Explicit finite durations removed the
   churn: no watcher replacement or renewal, no interrupted validation, no hang.
   Per the M3 rule, no renewal API is built and no global default is raised;
   the per-invocation explicit `timeout_ms` guidance (M1) and typed executor
   termination (M2) are the delivered behavior.
9. **Final check results:** focused executor/formatter/tool/prompt/streaming/
   sandboxed-code-host tests green (incl. new M2 coverage); `tsc --noEmit`
   clean; prettier clean (implementing session, 2026-09-06, ~950 tests).
   Full-suite gates: 8079 passed per run; the 5 failures are pre-existing in
   this environment (4 nested-TMPDIR needsApproval + 1 scripted-adapter
   acceptance; both classes reproduced on pristine main) and are untouched by
   this plan.
10. **Remaining uncertainties:** (a) post-merge verification item — cancelled
    background jobs notify with typed status `cancelled`, but the output
    summary header reads `timeout` until a harness instance runs the merged
    shell-output.ts (adds the `cancelled ? 'cancelled'` branch); (b) pilot
    values (7,200,000 / 2,000,000 / 900,000 ms) were per-invocation
    experimental choices, not measured safe defaults; (c) the pilot exercised
    the live watch-receipts.sh on isolated baselines — the session-query-index
    production watcher was not modified (runtime script outside the repo, per
    M1 item 1); (d) the scripted-adapter acceptance failure on main is a
    pre-existing workspace/environment issue outside this plan's scope.
11. **Rollback boundary:** revert the M1 guidance edits (shell tool
    description, background-shell addendum, AGENTS.md test policy/WIP, this
    plan's receipt) and/or the M2 executor/logging commit — no stored setting
    was changed and none needs migration. Merged commit references are recorded
    in the plan header and AGENTS.md on close.
5. **Post-merge verification item (not a defect):** cancelled background jobs
   notify with typed status `cancelled`, but the notification output summary
   header still reads `timeout` while the live harness runs main's pre-M2
   `shell-output.ts` (`timedOut ? 'timeout' : exit …`, no cancelled branch).
   The worktree M2 diff already adds `cancelled ? 'cancelled' : …`
   (shell-output.ts:46/139). Verify the header reads `cancelled` after merge and
   a harness instance restart.

