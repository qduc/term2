# Tool-interface Stage 3: explicit failures and partial completion

## Resume here

This is a specification draft for discussion, not implementation authorization
or a claim that Stage 3 is complete. The September 7 roadmap described Stage 3
as "explicit failures/partial completion" (handoff in session `d2898582`).
The proposed compatibility policy below needs a user decision before finalizing
the implementation contract. No runtime edits or live runs belong to this draft.

Baseline: compact discovery shipped in `60e55030`; action receipts shipped in
`3e6e222e`, with clipping/adapter repair merged in `66ab91dc`. Stage 2 native
structured returns remain a separate halted experiment, not a prerequisite or
an implicitly approved part of Stage 3.

Read alongside [action receipts](run-code-action-receipts.md),
[output and effect safety](tool-output-and-effect-safety.md), and
[run_code authoring friction](run-code-authoring-friction.md).

## Decision sought

**Recommended first slice: preserve existing script-facing return values and
throw/rejection behavior; improve host-owned evidence and its presentation.**
An alternative that converts resolved semantic errors into rejections changes
script control flow and compatibility. If wanted, specify and measure that as
a separate treatment rather than bundling it into an evidence repair.

A resolved error value and a thrown error are not interchangeable. Neither
automatically proves that an effect did not happen. Stage 3 must make those
distinctions usable without requiring models to infer them from prose.

## Problem and verified starting points

Inspection baseline: `66ab91dc`, principally
`source/tools/system/run-code/run-code.ts`. These are scoped observations,
not a catalog-wide audit:

- `RunCodeCallRecord` records transport/policy outcomes but has no call identity
  field. Its `ok` means the executor resolved, not that the action applied.
- `ACTION_SEMANTICS` and `RunCodeActionReceipt` independently capture semantics
  for exactly `configure_task_check_in` and `cancel_run`. Stage 3 must reuse
  their owner and stable identities rather than create a competing action ledger.
- `renderResult` exposes script failure, selected refusal categories, action
  receipts, and call counts. A script can catch an ordinary nested error and
  return a success claim without a per-call failure detail section for that
  non-covered tool. A normal empty query result is not such a failure.
- `isUnsuccessfulRunCodeOutput` derives a presentation success bit from rendered
  prefixes and the script value. That is not a trustworthy effect classifier.
- In the auto-approved `invoke` path, execution, recording success/receipts, and
  `serializeResult` share one try/catch. A delivery/serialization exception can
  reach the same catch as an executor exception, add another call record, and
  replace a covered action receipt with `failed`. The spec must distinguish
  effect evidence already obtained from failure to deliver its result. Exact
  reachable payloads and the nested-approval sibling need regression evidence
  before choosing a patch.

The desired change is not "more error text." It is sufficient host evidence to
report what completed, what did not, and what remains uncertain without
blindly repeating work that may already have taken effect.

## Proposed first-slice scope

- The nested `run_code` boundary: host-observed call lifecycle failures, result
  delivery failures, and partial completion across the calls it actually observed.
- Existing two-tool semantic receipts remain in scope as a baseline contract.
- Other resolved semantic-error values enter scope only through an explicit,
  reviewed per-tool contract. The candidate list is an open inventory item;
  this draft does not authorize adapters for the entire catalog.
- Existing outer-call recovery statuses, direct tool return representations,
  approval ownership, provider continuation, and execution limits are unchanged.

Non-goals: inferring intended/omitted actions or correct targets; automatic
retries, rollback, exactly-once execution, generic throwing on an `error` key,
a new workflow DSL, and reviving Stage 2. No live receipt-pilot result proves
that all tools need the same outcome schema.

## Behavioral contract proposed for review

1. **Keep execution, delivery, and effect evidence distinct.** If an executor
   reports an applied effect and serialization later fails, report the applied
   effect plus unavailable/failed result delivery. Do not relabel it as an
   unapplied operation. Without sufficient effect evidence, say unknown.
2. **Account by stable call identity.** One observed invocation contributes once
   to each applicable summary; record updates must not count as extra calls.
   Distinguish pre-dispatch rejection from failure after dispatch. Admission
   rejection identifiers must not imply that execution occurred.
3. **Preserve evidence through script control flow.** Catching, ignoring,
   relabeling, returning early, or failing later must not erase prior host
   observations. This does not require making more operations throw.
4. **Describe partial completion over observed calls only.** Show known completed
   work alongside rejected, failed, or unsettled calls; do not report a single
   whole-task success/failure bit. Promise fulfillment is not proof of applied
   effect; an executor exception is not proof of no effect.
5. **Do not invent work that was never observed.** A script stopping before its
   next call does not establish the existence of an expected-but-skipped action.
   A timeout must not convert an unobserved effect into a safe-to-retry failure.
6. **Bound presentation without hiding negative or uncertain evidence.** Reuse
   the existing output/artifact policy. Preserve aggregate evidence when details
   overflow, disclose unavailable artifacts, and do not advise replay to recover
   output. Budget allocation for combined call/action summaries is a design item.
7. **Keep ordinary successful reads quiet.** Do not duplicate every return value
   or produce success certificates for observation-only scripts. Preserve the
   useful short-output path; measure added context rather than assuming it is free.
8. **Keep labels honest.** A call-level failure is not a task-level verdict or
   an effect-level guarantee. Any change to UI/telemetry success classification
   must name the dimension it represents and audit its consumers first.

## Evidence needed to make this implement-ready

- A bounded inventory of nested execution, serialization, approval, and
  termination paths, including their existing record/receipt ownership.
- A consumer map for the presentation success bit: identify whether it affects
  only display or also recovery, stall detection, or other execution policy.
- A small table of candidate semantic-error contracts with real executor
  signals, legitimate negative/empty results, and false-positive counterexamples.
  Exclude candidates whose semantics cannot be established from host evidence.
- Red fixtures for swallowed nested failure, effect-before-delivery-failure,
  mixed completed/rejected work, and dispatched-but-unsettled work. Record what
  the current implementation already handles; avoid rebuilding that behavior.
- A concrete output example and internal ownership proposal, with no second
  authoritative action ledger and no generic `ok`/`error` inference rule.

## Acceptance and measurement plan

Deterministic coverage must distinguish validation/approval rejection, executor
throw, semantic non-application, delivery failure after effect, and unsettled
execution. Exercise sequential calls, parallel calls, caught errors, and
result/console/error overflow with artifact success and failure. Assert stable
counts, preserved evidence, and unchanged script-visible behavior in the
compatibility-preserving treatment. Verify legitimate empty/negative reads.

Use focused baseline/red-green tests, related tests per production file,
typecheck, changed tests, and the isolated full suite at handoff. Shared host,
run-loop, or provider changes require their additional documented gates.

Before implementation acceptance, run a preregistered paired live comparison
across Luna, GLM 5.3 Flash, and DeepSeek V4 Flash. Resolve and confirm exact
routes/effort for that run; the earlier six-cell probe is not this stage gate.
Use native tool-result continuation or an equivalent production-path fixture,
not merely a user-message quotation. Include mixed outcomes and uncertain
effects as well as a successful control. Freeze scenarios, sample count, cost
limits, and stopping rules before paid execution.

Primary measures: false completion claims, unnecessary mutation replay, and
correct uncertainty/partial-completion reporting. Secondary measures: recovery
turns, tool calls, prompt/output tokens, latency, and context added. A correctness
regression blocks advancement; an improvement claim needs observed behavioral
benefit, not receipt-text presence. Do not erase a failed cell by retrying it.

## Next decisions

- **User:** confirm compatibility-preserving evidence first, or request a separate
  script-facing failure-contract treatment. This is the only immediate product
  choice needed to proceed with the detailed spec.
- **Engineering investigation:** settle the smallest affected tool/path set,
  output layout, consumer semantics, and reused record ownership from code.
- **Before live execution:** finalize the reviewed protocol and model routes.
  No paid measurement or broader implementation is implied by this draft.
