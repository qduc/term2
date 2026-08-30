# Roadmap: stabilize before expanding

Status: **Stabilization tranche complete (Phases 0–3 closed 2026-08-16); feature expansion resumed.** The operating rules below remain the standard workflow.

## Goal

Make the behavior already implemented trustworthy before adding another broad
feature surface.

This tranche will:

1. define the contracts at the system's highest-risk ownership seams;
2. turn those contracts into deterministic public-boundary tests;
3. repair only demonstrated violations, one independently revertible change at
   a time; and
4. make contract-first implementation and change-surface quality gates the
   normal workflow for future work.

This is not a rewrite, a coverage-percentage campaign, or a permanent feature
freeze. Existing ownership boundaries remain in force unless a red-proven
contract violation shows that an interface cannot uphold its responsibility.

## Operating mode during stabilization

### Allowed

- Critical security, data-loss, effect-safety, and release-blocking repairs.
- Contract characterization, test infrastructure, and deterministic baseline
  repairs.
- Fixes for violations proven through an owning public boundary.
- Small release and maintenance work that does not introduce a new runtime
  boundary.

### Paused

- New product features or provider capabilities.
- Broad refactors justified only by code shape or defect counts.
- New `Manager`, `Coordinator`, `Runner`, `Handler`, state machine, or generic
  scope container without a demonstrated ownership gap.
- Threshold tuning or guard weakening without a written guard contract and red
  false-positive evidence.
- Opportunistic cleanup mixed into a contract repair.

### Working rules

1. Keep one stabilization outcome active at a time. Parallel work is allowed
   only when branches touch independent owners and are independently mergeable.
2. Use an isolated worktree for every non-trivial repair. Preserve unrelated
   work in the primary checkout.
3. Write the contract and the public-boundary red proof before changing
   production behavior.
4. Treat every failure as one of: product defect, test defect, fixture defect,
   dependency defect, environment limitation, or known baseline. Do not repair
   production code to hide a failure owned elsewhere.
5. A regression test is the floor. Every non-trivial fix must also examine
   sibling paths and the detection gap that allowed the defect class.
6. Run tests with `NODE_ENV=test`. Never report a check as passing unless it was
   run and succeeded.

## Ownership model to preserve

Stabilization strengthens the protocols between existing owners; it does not
collapse them into a universal controller.

| Concern | Current owner |
| --- | --- |
| Queued submission state and admission | `QueueController` |
| Request identity and executable payload routing | `ConversationAdapter` |
| Turn admission and status | `TurnCoordinator` and `TurnStatusMachine` |
| Turn execution workflow | `TurnWorkflow` |
| Request boundaries, steering, model streaming, and tool dispatch | `ApplicationRunLoop` |
| Interactive projection | `ConversationOrchestrator` and Ink |
| Approval decisions | `services/approval/` |
| Retry and recovery decisions | `services/retry/` |
| Provider transport details | `providers/` and `lib/` |
| Session composition | `services/session/session-composition.ts` |
| Subagent composition | `services/subagents/runtime.ts` |

An extraction earns its place only when deleting it would spread a stable
policy or invariant across callers. A module that merely forwards calls or
mirrors another owner's state does not qualify.

## Phase 0 — Establish a trustworthy baseline

Status: **Completed (2026-08-14).** Baseline results documented in [`docs/plans/validation-baseline-2026-08-14.md`](./docs/plans/validation-baseline-2026-08-14.md).

**Outcome:** failures discovered during stabilization can be classified against
a dated, reproducible baseline.

### Work completed

- Recorded the original Phase 0 baseline and the final Phase 1 verification of:
  - focused tests for each critical seam (76 file invocations / 1,683 passing
    test invocations plus one retained expected-failure characterization in the
    completed Phase 1 matrices);
  - `NODE_ENV=test pnpm test` (final Phase 1 run: 483 files passing, 1 skipped;
    6,221 tests passing, 1 expected failure, 2 skipped);
  - `pnpm typecheck` (clean, 0 errors);
  - `NODE_ENV=test pnpm test:provider-black-box` (19 files / 166 tests passing);
  - formatting and lint checks used by the release path (`pnpm lint` clean).
- Classified environment-only behaviors (Node `TimeoutNaNWarning`, expected `openai-websocket.reasoning` fixture skip, non-interactive e2e harness skips).
- Recast `docs/plans/escaped-defects-30d/` as an unnormalized empirical evidence inventory with methodological disclaimers. (That directory was never committed and is not present in this repository; only `docs/plans/validation-baseline-2026-08-14.md` still cites it.)

### Exit criteria met

- One dated baseline records the exact commands, results, environment-only
  limitations, and owner of every unresolved failure (`docs/plans/validation-baseline-2026-08-14.md`).
- At baseline establishment, all recorded gates were green and no product
  failure had yet been demonstrated. The later Phase 1 red characterization is
  classified separately and queues its repair in Phase 2.

## Phase 1 — Define executable seam contracts

Status: **Completed (2026-08-14).** Contract records and deterministic matrices
are owner-reviewed in [`docs/contracts/`](./docs/contracts/README.md); all five
focused test commands exit green (76 file invocations / 1,683 passing test
invocations plus one retained expected-failure characterization).
The Phase 0 Seam 2–4 command discrepancy was a test-record defect: nonexistent
paths let Vitest silently skip coverage. The authoritative baseline now records
the corrected commands and retains the discovery as a dated correction note.
All minimum-matrix cells are characterized. One product/design defect was
demonstrated and queued for Phase 2 — a WebSocket receive-watchdog timeout
terminating as an ambiguous outcome instead of reaching the documented
HTTP/full-history fallback — and it was repaired on 2026-08-15 (see Phase 2).

**Outcome:** the most failure-prone cross-owner behavior is stated in observable
terms and has a deterministic contract matrix.

Each contract record must name:

- the invariant and user-visible harm it prevents;
- enforcement owner and recovery owner;
- all execution paths that share it;
- identities and state that cross the boundary;
- success, failure, cancellation, retry, and ambiguous-outcome settlement;
- observability needed to diagnose a violation;
- the public boundary through which it will be tested; and
- the focused and broader verification commands.

### 1. Conversation submission and turn lifecycle

Owners: `QueueController`, `ConversationAdapter`, `TurnCoordinator`,
`TurnStatusMachine`, and the `ConversationOrchestrator` projection.

Contract:

- A submission has stable identity from admission through terminal settlement.
- Queued, activating, active, awaiting-approval, continuing, and terminal states
  cannot be mistaken for one another.
- Every accepted request promise settles exactly once on success, rejection,
  removal, cancellation, recovery, or failure.
- UI pending and active projections follow domain events and cannot keep a
  settled request visible as queued or running.
- A steer belongs to a declared turn until its next request boundary or is
  truthfully admitted as a separate queued turn; stream-segment gaps cannot
  silently drop it.

Minimum matrix:

- immediate execution and deferred queue execution;
- remove or edit before start;
- cancel with zero, one, and multiple retained items;
- repeated approval continuations;
- stale approval identity;
- retry or recovery before stream start and after partial stream output;
- UI projection with start callbacks delayed, skipped, or replayed.

### 2. Provider input, continuity, and effect settlement

Owners: tool ledger and history projection, `ProviderContinuity`,
`SessionInputPlanner`, chained-input filtering, and retry/recovery policy.

Contract:

- Every provider-facing tool result has one matching call in the applicable
  full-history request or live provider chain.
- Ledger reconciliation cannot duplicate, reorder, or resurrect a settled pair
  across replay or compaction boundaries.
- A live chain with unpaid tool debt is either paid completely or dropped before
  the next request.
- Chained delta validation and full-history validation remain distinct; a
  transport downgrade is allowed only after local history, continuity, and
  effect state are safe for replay.
- Never-dispatched effects settle as `aborted`; dispatched-but-unobserved effects
  settle as `unknown` and are never blindly re-executed.
- Provider-native opaque state remains provider-scoped.

Minimum matrix:

- complete and partial parallel tool-call batches;
- pre-stream and mid-stream transport failure;
- failure before dispatch and after dispatch;
- approval pause and continuation;
- compacted history, replacement boundaries, save/resume, and stateless replay;
- orphan, duplicate, missing, and out-of-order call/result items;
- chained, forced-full-history, and transport-downgrade requests.

### 3. Child-run identity, authority, and lifecycle

Owner: `createSubagentRuntime` and its strategy-specific runners, with event
routing in `SubagentBridge` and provider traffic identity in session context.

Contract:

- Every child run receives an identity distinct from the parent and stable
  across its own continuations.
- Foreground, background, adopted, mentor, evaluator, and nested-child events
  reach only their owning sink.
- Global settings intended to apply to children are resolved consistently, while
  permissions and execution budgets may only stay equal or attenuate.
- Parent, turn, conversation, and explicit-user cancellation affect exactly the
  child scopes they own.
- Every started child emits a truthful terminal state: completed, failed,
  cancelled, or interrupted.
- Admission failures preserve typed error codes and do not mutate running work.

Minimum matrix:

- foreground and background runs;
- nested child-of-child runs;
- evaluator traffic;
- continuation of persistent roles;
- provider session identity;
- inherited approval settings and attenuated capabilities;
- parent abort, turn abort, adopted transfer, explicit stop, and session dispose;
- duplicate role/name admission and structured error round-trip.

### 4. Settings consumption

Owners: settings schema and source resolution plus the runtime owner consuming
each setting.

Contract:

- Every user-facing setting has a runtime consumer or is explicitly marked as
  presentation-only or restart-only.
- Schema default, runtime fallback, persisted value, environment override, role
  override, and per-invocation override have one documented precedence order.
- A runtime-modifiable setting takes effect at its promised boundary.
- The effective value—not merely schema presence or UI mutation—is tested.

Minimum matrix:

- default, customized, minimum, maximum, invalid, and migrated values;
- root, nested, mentor, background, workflow, and non-interactive consumers
  where applicable;
- runtime change at the request boundary promised by `/settings`.

### 5. Runtime guards and retention

Owners and contracts remain recorded in `docs/plans/guard-ledger.md` and any
linked owner plan.

Contract:

- Admission limits reject only new work and leave admitted work untouched.
- Retention bounds remove only state proven dead or preserve omitted material
  through a retrieval path.
- Inactivity watchdogs observe meaningful activity at their named boundary.
- Containment budgets remain finite and use staged escalation where authorized.
- Security and authority boundaries stay fail-closed.
- Every destructive action is justified by direct evidence, settles partial work
  truthfully, and reports a typed recovery classification.

Minimum matrix:

- threshold minus one, threshold, and threshold plus one;
- a genuine harmful case;
- legitimate work that resembles the signal;
- cancellation, retry, fallback, and ambiguous outcomes;
- every shared root, child, workflow, non-interactive, and shell path.

### Exit criteria

- Every contract above has an owner-approved record and a focused test command.
- Existing green behavior is characterized before any production repair.
- Every discovered failure is classified; only product defects proceed to
  Phase 2.

## Phase 2 — Repair demonstrated violations

Status: **the one demonstrated violation is repaired (2026-08-15).** A
first-frame WebSocket watchdog timeout that the send path proves never reached
the wire now recovers through the existing bounded `transport_downgrade` →
`retry_fresh` / `full_history` path instead of terminating the turn. Evidence is
recorded by the send path in `providers/websocket-request-dispatch.ts`, never
inferred from error text, and an unrecorded request reads as `unknown` so a
missing record cannot authorize a replay. A timeout after the frame was flushed
to an OPEN socket remains ambiguous and still terminates: that is an approved
deferral, not a gap, because the protocol offers no resume signal that could
distinguish an unseen request from an accepted one. Both sides are now covered
by passing tests at the initial-turn recovery boundary; the retained
expected-failure characterization is retired. See
[`docs/contracts/05-runtime-guards-and-retention.md`](./docs/contracts/05-runtime-guards-and-retention.md) §10.

Supporting observability landed alongside it: the watchdog now reports the
first-frame latency, largest inter-frame gap, and expired wait it measured,
together with the budgets it judged them against, into the provider traffic log.
Before this, the guard's own margin was unobservable, so a threshold could only
be found wrong by a live request losing its turn.

**Outcome:** current behavior satisfies the contracts without speculative
architecture work.

### Priority order

Prioritize by potential harm and replay risk, not by raw defect frequency:

1. authority bypass, data loss, and ambiguous external effects;
2. invalid provider history and unsafe recovery;
3. non-settling or misattributed queue and turn state;
4. child identity, event, permission, and cancellation leaks;
5. settings divergence and destructive guard false positives;
6. presentation-only inconsistencies.

### Repair loop

For each violation:

1. Reproduce it deterministically through the owning public boundary.
2. Record why types, tests, review, and observability did not catch it.
3. Search sibling owners and execution paths for the same mechanism.
4. Choose the smallest owner-level repair that satisfies the contract.
5. Keep the behavior change and its test independently revertible.
6. Run focused tests during development.
7. Run `pnpm typecheck`, formatting for changed files, and the broader suite
   proportional to the affected surface.
8. Run `NODE_ENV=test pnpm test:provider-black-box` during development for provider, bridge,
   run-loop, registry, or non-interactive changes.
9. Record confirmed checks, baseline failures, and remaining risks separately.

Do not convert an unproven remaining risk into implementation work. First give
it a red characterization or retain it as an explicit hypothesis.

### Exit criteria

- Every red contract test has a merged repair, an approved deferral with owner
  and rationale, or evidence that the failure belongs outside production code.
- No repair weakens an authority boundary, loses admitted work, fabricates
  failure, or blindly replays an ambiguous effect.
- Focused, broad, and provider gates required by each change have truthful
  recorded outcomes.

## Phase 3 — Install the future implementation workflow

**Outcome:** future features cannot cross an important boundary without naming
and testing the contract they change.

### Step 1: Frame the change

Before implementation, record:

- user-visible outcome;
- owning module and public boundary;
- invariant being added or changed;
- affected root, child, workflow, UI, provider, and non-interactive paths;
- failure, cancellation, retry, and recovery semantics;
- explicit non-goals;
- acceptance criteria and exact verification commands.

If ownership is unclear, stop at design. Do not resolve uncertainty by creating
a generic coordinator or placing policy in a convenient caller.

### Step 2: Prove the contract red

- Write deterministic tests through the owning public interface.
- Mock only true boundaries.
- Assert typed state, codes, identity, and settlement rather than broad strings
  or snapshots unless text itself is the contract.
- Cover the meaningful boundary cases before production code.

### Step 3: Implement a vertical slice

- Make the minimum production change at the owner.
- Preserve policy, transport, persistence, and presentation boundaries.
- Keep unrelated cleanup out of the branch.
- Use an isolated worktree for non-trivial work.

### Step 4: Close the defect class

Before declaring the change complete:

- inspect sibling implementations and execution paths;
- ask what made the invalid state representable;
- add an owner-level contract, exhaustive type, lint rule, or CI check when it
  proportionally prevents the class;
- document any residual hypothesis without presenting it as observed evidence.

### Step 5: Pass change-surface gates

| Change surface | Required gate |
| --- | --- |
| Local implementation | Focused owner tests with `NODE_ENV=test` |
| Shared utility or architectural boundary | Relevant contract matrix plus full test suite |
| Provider, bridge, run loop, registry, non-interactive | Focused tests, typecheck, and provider black-box suite |
| Ink input or modal ownership | App-dispatcher ownership tests and focused Ink tests |
| Setting | Effective runtime-consumption test plus settings UI/schema coverage |
| Runtime guard | Written guard contract, red false-positive/true-positive matrix, and guard-ledger update |
| Non-trivial bug fix | Specimen regression, sibling-path audit, and detection-gap disposition |
| Prompt or tool description | Behavioral test preserving non-obvious prompt/tool contract |

### Step 6: Review and hand off

- Review both repository standards and the originating specification.
- Report exact commands and results; separate known baselines and environment
  limitations.
- Update the plan's `Resume here` section before a handoff.
- Merge only intended files; do not commit or push unrelated user work.
- After merge, update durable ownership or workflow documentation when the
  contract changed.

### Institutionalization work

- Complete the remaining service-seam dispositions as parallel read-only
  audits through
  [`docs/plans/service-boundary-contract-completion.md`](./docs/plans/service-boundary-contract-completion.md).
  Synthesize their evidence before proposing separately authorized changes.
  This follow-up does not broaden Phase 4's release gate: only a demonstrated
  contract violation can become repair work or block stabilization exit.
- Encode the workflow's non-negotiable gates in `AGENTS.md`.
- Add lightweight change templates for contract, recovery, test matrix, and
  verification evidence.
- Automate stable mechanical checks in CI; keep environment-sensitive or paid
  live canaries separate until their signal and ownership are proven.
- Keep `docs/plans/` current: completed plans retain only constraints that still
  prevent reintroducing a defect.

## Phase 4 — Exit stabilization deliberately

Feature work resumes only when all of the following are true:

1. The five critical seam contracts have authoritative owners and executable
   baseline tests.
2. Every red characterization has a recorded disposition.
3. The standard suite, typecheck, and applicable provider black-box suite have a
   dated trustworthy result; remaining limitations are classified and owned.
4. The future implementation workflow and change-surface gates are recorded in
   the repository's authoritative agent instructions and review process.
5. No open security, data-loss, ambiguous-effect, or provider-continuity defect
   remains hidden inside a general backlog.
6. One bounded feature is selected to exercise the new workflow end to end.

The first feature after stabilization is a calibration run. Its plan and review
must show that the new workflow catches boundary mistakes before merge without
requiring a universal controller or an unbounded test campaign.

## Definition of success

The project is ready to expand again when confidence comes from executable
contracts rather than familiarity with the implementation:

> Preserve the existing owners, make their boundary invariants observable,
> repair demonstrated violations, and require every future feature to prove the
> contracts it changes before it merges.
