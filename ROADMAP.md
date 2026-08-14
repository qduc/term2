# Roadmap: finish deliberately without getting lost

The key is to stop treating “all known improvements” as one backlog. Use a **single active outcome**, with every other item explicitly parked.

## Operating rules

1. **One product initiative in flight at a time.**
   Allow parallel implementation only within that initiative when tasks are independently mergeable.

2. **Make `docs/plans/` the source of truth.**
   Each active plan must begin with:
  - current status and owner,
  - user-facing problem,
  - explicit non-goals,
  - acceptance criteria,
  - validation commands and baseline failures,
  - a “Resume here” section updated at every handoff.

3. **No “done” without observable proof.**
   A feature is complete only when its acceptance criteria, focused tests, and applicable black-box/provider tests pass—or when any exclusions are documented with an owner and expiry.

4. **Treat test instability as capacity debt.**
   Do not let known timeouts and environment-sensitive failures become permanent background noise. A failing test suite makes future feature work harder to trust.

5. **Use a fixed WIP limit.**
   At most:
  - one implementation milestone,
  - one investigation,
  - one deferred design awaiting a decision.

---

## Phase 0 — Re-establish a trustworthy baseline

**Goal:** make it obvious which validation signals are real before expanding behavior.

### Work

- Confirm the current status of documented validation debt:
  - Ink `act is not a function` failures caused by test environment / `ink-prompt` behavior.
  - the Responses-lifecycle PTY timeout in provider black-box testing.
  - the environment-sensitive `source/cli.e2e.test.ts` terminal-output timeout.
- Separate failures into:
  - fixed,
  - reproducible product/test defects,
  - environment limitations,
  - intentionally skipped coverage.
- Ensure standard test commands pin `NODE_ENV=test`, as required by `AGENTS.md`.
- Update old plan records that only describe historical failures, so they do not masquerade as current regressions.

### Exit criteria

- A clean, dated baseline report says exactly:
  - which suites are green,
  - which failures remain,
  - whether each is a product defect, test defect, or environmental constraint,
  - the owner and next action for each remaining item.

**Why first:** otherwise every subsequent milestone has ambiguous validation, which is the fastest way to lose confidence and context.

---

## Phase 1 — Finish the small, bounded background-work experience gap

**Source:** `docs/plans/background-work-control/liveness-ui.md`

**Goal:** make background task state honest: lifecycle, recent evidence, and context use must be independently visible.

### Work

- Split the current exclusive activity state into separate concepts:
  - lifecycle phase and reason,
  - last observation time/source,
  - derived liveness or evidence age.
- Expose provider-wait plus “no recent evidence” simultaneously.
- Add background subagent model/context-window and latest-request usage to the control projection.
- Update compact and manager views while preserving narrow-width identity and existing cancellation semantics.
- Add regression tests for:
  - provider-waiting task that becomes quiet,
  - recently active task,
  - context usage display,
  - narrow terminal layouts,
  - no change to task execution, cancellation, or transfer lifecycle.

### Exit criteria

Every acceptance criterion already listed in the plan is met, focused UI tests pass, and existing background-task control behavior remains unchanged.

**Why second:** it is intentionally presentation-only, has a bounded contract, and resolves a real user-trust problem without entangling execution policy.

---

## Phase 2 — Replace “budget exceeded” failure with controlled escalation

**Source:** `docs/plans/run-budget-stall-escalation.md`

**Goal:** the harness provides sensation (cost, time, stall), not decisions. Limits become evidence a judge can act on, not a throw that silently loses an otherwise recoverable run. See the Goal section of the source plan.

### First make the unresolved decisions explicit

Before implementation, decide and record:

1. **Budget denominator:** model turns, model requests, wall-clock duration, cost, tool count, or a defined combination.
2. **Escalation policy:** warning threshold, check-in threshold, hard-stop policy, and whether the user can extend or terminate.
3. **Cost behavior:** priced requests use available accounting; unpriced requests use an explicit fallback and are never treated as free.
4. **Failure-loop policy:** what evidence constitutes repetition, when it is surfaced, and when retry suppression is appropriate.
5. **Ownership:** one authoritative budget policy; other components report observations rather than independently enforcing limits.
6. **No-limit behavior:** preserve the existing wrap-up/continuity behavior when `maxTurns` is unset.

### Then implement in vertical slices

1. Establish the budget/evidence model and its unit tests.
2. Reconcile `ApplicationRunLoop`, `ExecutionBudget`, `AgentLimits` / `resolveLimits`, and the `max_turns_exceeded` prompt around that model.
3. Add user-visible warnings/check-ins at safe request boundaries.
4. Implement cost and unpriced-request behavior.
5. Surface repeated-failure evidence rather than making it a silent local intervention.
6. Add run-loop and provider black-box scenarios for escalation, continuation, decline, tool debt, and recovery.

### Exit criteria

- Exceeding a soft turn budget does **not** discard run work.
- Users receive actionable, evidence-based escalation.
- Cost accounting behaves safely for both priced and unpriced requests.
- Exactly one component owns budget enforcement.
- Run-loop/provider changes pass the required provider black-box suite.

**Why third:** this is the highest-value known correctness issue, but it is also the deepest cross-cutting change. It deserves the focused attention of a single active initiative.

---

## Phase 3 — Complete and harden public hooks

**Source:** `docs/plans/public-hooks-system.md`

**Goal:** graduate hooks from “core implementation complete” to a reliable public extension contract.

### Work

- Resolve or isolate the remaining validation failures so hook behavior is tested against a credible suite.
- Test:
  - discovery and loading,
  - registration and cleanup,
  - callback ordering,
  - TypeScript loading,
  - filesystem write protection,
  - shutdown behavior,
  - malformed or throwing user hooks.
- Define compatibility policy:
  - stable hook names and payload schemas,
  - deprecation window,
  - explicit behavior when a hook fails.
- Publish a small reference extension plus contract documentation.

### Exit criteria

The hooks integration tests and associated validation pass; hook contracts, error semantics, and compatibility expectations are documented; a user can create a supported hook without relying on internal code.

**Why fourth:** public extension points magnify defects. Hardening them after the run-loop policy settles prevents extensions from binding to unstable behavior.

---

## Phase 4 — Add live provider canaries

**Source:** deferred item in `AGENTS.md`

**Goal:** find integration breakage against real providers before users do, without turning CI into a secret-leaking or cost-unbounded system.

### Decisions required

- Which providers/models are covered initially.
- CI secret storage and access policy.
- OAuth credential storage/refresh strategy.
- Per-run and monthly spend ceilings.
- Schedule, retry policy, alert destination, and human owner.
- What payloads/logs are retained and how sensitive fields are redacted.

### Initial scope

Keep the first canary small:

- one low-cost request per supported provider transport,
- a basic streaming assertion,
- one tool-call round-trip where applicable,
- request/response schema and auth failures captured as redacted diagnostics,
- strict timeout and spend cap,
- a non-blocking alert rather than a release-blocking gate at first.

### Exit criteria

Canaries run on schedule with bounded cost, no secret exposure, redacted evidence, actionable alerts, and documented ownership. Promote selected canaries to release gates only after several weeks of reliable signal.

**Why last:** it needs organizational and infrastructure decisions, not merely code. Implementing it early risks producing an expensive, noisy, unowned job.

---

## Maintenance lane: keep the map usable

At the end of each completed phase:

1. Mark the plan complete in `AGENTS.md`.
2. Move its design record under **Completed** only if it contains enduring constraints future work must respect.
3. Remove stale failure notes or label them historical with a fix reference.
4. Create exactly one next active plan; do not activate every deferred idea.
5. Record a short release note: behavior changed, compatibility implications, validation evidence, and follow-ups.

## Priority order

| Order | Initiative | Reason |
|---|---|---|
| 0 | Validation baseline | Restores trust in every later result |
| 1 | Background liveness UI | Bounded, user-visible, low execution risk |
| 2 | Budget escalation | Largest known behavior/correctness gap |
| 3 | Public-hook hardening | Makes extension surface dependable |
| 4 | Provider canaries | Ongoing production confidence, requires external decisions |

This gives the project a finish line without pretending it has a final endpoint: **first make the signals trustworthy, then fix the user-visible ambiguity, then repair the deep run-control policy, then stabilize extensibility, and finally automate real-world confidence.**
