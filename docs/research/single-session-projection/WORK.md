# One session projection state

Goal: one session projection object lives from preparation through completion,
including approval segments and recovery. One path processes events, finalizes
history, reports compaction, and builds results. Preserve observable behavior.

Baseline: bd59c499. Worktree: codex/single-session-projection.
Risk: high. Independent verifier: /root/projection_verifier.

Acceptance:
- Source has one projection state allocated per logical turn and one stream
  projection/result-building path; approval cannot allocate another state or
  copy accumulated projection facts from a pending-approval snapshot.
- Repeated approvals retain tool arguments, command deduplication, reasoning,
  journal facts and cumulative usage (latest replaces rather than sums).
- Existing initial-versus-continuation recovery policy, retry inputs/provider
  continuity, cancellation, successor admission, compaction and persistence
  behavior pass appropriate built CLI and integration checks.
- Typecheck/lint/static/no-unit checks pass, independent verification accepts
  the final source, architecture docs and experiment ledger are updated.

Constraints: no provider protocol, approval authority, recovery limit, deadline,
queue policy or execution-ownership changes; no release; preserve shared checkout.
Attempt-specific retry input remains separate from whole-turn projection state.

Verification plan: built provider black-box suite (including repeated approval,
turn-decisions and session resilience), integration/e2e suites, and focused
independent probes where existing cases do not establish the claims.

Implementation:
- `TurnProjectionState` replaces the approval-created `ContinuationState` and is
  allocated once before the first stream. Recovery retains object identity and
  resets attempt facts via `resetForAttempt`.
- One `#projectStream` path handles initial and decision segments; segment source
  retains existing tool-argument, logging and recovery-policy distinctions.
- Decisions bind the existing state. Removed unused cumulative message/item
  snapshots and usage hand-offs from pending/prepared approval contracts.
- The existing built CLI question scenario now crosses two manual decisions in
  one turn, asserting call/result identity and provider chaining, then cancellation
  and successor admission. Focused run: 1 passed. Static guards: 28 passed.

Design limits: recovery policy still distinguishes request attempts from failures
following an approval. These policies and physical execution ownership are outside
this projection consolidation. Accepted items/history retain their existing stores.

Review correction: preparation belongs to the new attempt

The first draft reset projection facts after input preparation. On recovery,
preparation could therefore fail while the retained state still described the
previous continuation, selecting the wrong recovery handler. This was caught
before commit. `#prepare` now resets state immediately after obtaining an attempt,
before either backoff or input preparation. The independent injected-preparation-
failure probe confirms initial recovery runs and the same projection object stays
alive. No new flag, guard, scheduler or policy was added.

Retrospective checks:
- Representability: the segment source is mutable; ordering must establish it
  before fallible preparation. A separate state machine would add mechanism.
- Single truth: source on the retained projection object selects existing policy.
- Boundary: input preparation may throw; it is inside the attempt boundary.
- Coupling: reset must precede delay/preparation; moved to their common entry.
- Assumption: preparing a replay is not guaranteed to succeed.
- Detection: ordinary success/recovery probes missed a failure during preparation;
  the verifier added that injection, observing initial-handler dispatch.
- Automation: typechecking cannot establish exception ordering; no new static
  guard was added. Retained runtime probe supplies repeatable evidence.
- Siblings: source selection in consume, interaction, recovery and recordSuccess
  and state mutation in bindDecision/advanceFromPlan/resetForAttempt inspected.
- Knowledge: existing separate-state deletion implicitly marked the new attempt;
  retaining identity required replacing that implicit lifetime signal explicitly.
- Observability: found within this task by source review and confirmed by probe.
- Origin: uncommitted refactor draft; no escaped production defect.

Final verification: accepted

Final source/build checks passed: typecheck, build, lint (31 existing warnings,
zero errors), 28 static guards and the no-unit-test policy. Integration passed
121 tests with one existing skip; e2e passed 31; provider black-box passed 204
with one existing skip. All final suite logs are retained in `evidence/`.

Independent verification accepted the exact final source: three runtime probes
and the built CLI repeated-question/cancellation/successor journey passed. The
seven production source hashes match the retained manifest. See VERIFICATION.md
for claims, observation boundaries and evidence. The temporary executable probe
was removed; its source is retained as text. Interrupted checks involving that
file are retained separately from passing final checks.

Limits: deterministic fixture providers, no live external-provider calls, no
human comprehension measurement or exhaustive scheduling proof. Existing test
skips remain. No release or provider/recovery-policy change.
