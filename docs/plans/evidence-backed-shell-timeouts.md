# Evidence-backed shell timeout improvements

## Resume here

This is a proposed improvement plan, not a runtime change. The September 6,
2026 investigation supports two bounded problems: receipt-watcher restart churn
and validation commands interrupted by shell runtime limits. Start with the
existing per-call finite timeout, not a new watchdog or a blanket default increase.

Implement milestones 1 and 2 first. Milestone 3 is conditional on their observed
results. Each behavior-changing slice must have its own guard contract, red
proof, worktree, and rollback boundary. The user requested a plan; implementation
and changes to live watcher processes or persisted settings are outside this
document-only task.

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
