# No-unit-test experiment: interim findings, 2026-10-24

Historical assessment, not a current acceptance or policy decision. Evidence
cutoff: 2026-10-24 06:53:25 Asia/Ho_Chi_Minh (2026-10-23T23:53:25Z), source
`12dabc925efc1b72a63b885829a05c38a437ef69`. The user subsequently chose “Continue
with measurement and verification improvements.” Routine accounting was retired
on October 31; the [README](README.md) describes the unchanged testing gates.
The exhaustive frozen analysis and accounting data remain in git history before
this cleanup (`42724797`).

## What the evidence did and did not show

The hypothesis remained **unresolved**: lower total delivery cost and equivalent
quality were not established. Neither was a comparative decline sufficient to
justify immediate full rollback. This is not evidence that deterioration was
absent. Thirty tasks cannot establish confidence about rare regressions.

- Reported task completion mixed delivery, study, documentation, verification and
  rework. Author completion was not necessarily independent high-risk acceptance;
  several rows had missing commits or acceptance still pending.
- Recorded timestamp spans were not measured active effort. Verifier, rework and
  human effort, task-attributed tokens and costs were largely unavailable. Missing
  values were not zero; overlapping session counters could not be added together.
- The pre-experiment git sample provided auditable revisions but not matched task
  duration, repair cost or defect follow-up. Merge/fix counts were not task or
  escaped-defect denominators. Risk/activity mix and observation windows differed.
- Recent tasks had less follow-up, discovery was selective, and introducing-task
  attribution was sometimes unknown. A passing rerun could not erase the original
  failure or establish that no defects escaped.

Do not turn these records into a claim that unit tests were unnecessary, that
all completed work was accepted, or that a missing report meant no defects.

## Useful mistakes and verification improvements

- Removing the unit suite broke the scheduled catalog workflow because it still
  invoked removed tests. Main CI did not execute that route. When removing a
  command, inspect scheduled/release callers and run their actual validation path.
- Direct adapter checks missed Gemini tool continuation's required thought
  signature in the interactive pipeline. Cross the actual built-product boundary,
  including a tool call followed by continuation, not just the adapter's happy path.
- An unsafe agent-assembly migration was rejected before production: a settled
  denial with an undefined result could fall through to physical execution;
  disposal and production hook wiring were also missing. The lesson is explicit
  settlement state and actual production-construction/cleanup probes, not another
  success counter. The former ledger referenced a branch-local verification report that is not
  present in this source snapshot; do not infer acceptance from that pointer.
- A completion quick check covered unstaged changes but missed staged/untracked
  whitespace errors in the attested revision. Snapshot scope and checked scope
  must match. A default-on verification feature also needs a built-CLI case that
  leaves the default enabled, plus an unsupported-workspace failure diagnostic.
- Logging's initial EACCES check did not prove ENOSPC handling; a UTC-dated
  `/dev/full` fixture could miss the local-date rotating sink. Independent review
  found stderr payload leakage/no-transport accumulation and retention mistakes.
  Activate the actual sink and test local/UTC divergence, repeated writes and
  multiple instances. See [logging contract](../../contracts/07-logging-and-provider-traffic.md)
  and [targeted acceptance](acceptance-verification-2026-10-24.md).
- Rollover acceptance needed queued input at the real turn-end boundary, exactly
  once delivery and successor model-request capture, not only direct queue calls.
  See [queue/rollover findings](../rollover-queue/README.md).
- CLI approval fixtures inherited the child's sandbox temp authority, so ordinary
  outside-workspace targets became permitted scratch files. Isolate the child's
  temp root and test both denied outside paths and allowed scratch writes; a
  unique directory alone is not a distinct permission root.

More recurring environment and harness signatures are in the `testing` skill.
Guard signal/action, partial-work settlement and rollback lessons remain in the
[guard history](../../plans/approvals-and-sandbox/guard-ledger.md). These are
reusable causal notes, not requirements to resume per-task accounting.
