# Tool-interface Stage 3: explicit failures and partial completion

## Resume here

This is a specification draft for discussion, not implementation authorization
or a claim that Stage 3 is complete. The September 7 roadmap described Stage 3
as "explicit failures/partial completion" (handoff in session `d2898582`).
User decision (2026-09-08): develop the alternative that changes script-facing
failure semantics, rather than evidence-only compatibility preservation.
Successful return representations remain unchanged. The user also selected
**type-checked TypeScript scripts**, rather than transpile-only support.
[TypeScript specification](run-code-typescript.md) owns that additional slice.
No runtime edits or live runs are authorized merely by these specification
revisions.

Proposed delivery sequence: **3A, explicit failure semantics; 3B, type-checked
TypeScript against those contracts.** Measure each independently so compiler
benefits and failure-contract benefits are not conflated.

Baseline: compact discovery shipped in `60e55030`; action receipts shipped in
`3e6e222e`, with clipping/adapter repair merged in `66ab91dc`. Stage 2 native
structured returns remain a separate halted experiment, not a prerequisite or
an implicitly approved part of Stage 3.

Read alongside [action receipts](run-code-action-receipts.md),
[output and effect safety](tool-output-and-effect-safety.md), and
[run_code authoring friction](run-code-authoring-friction.md).

## Selected direction: explicit script-facing failures

**Selected: designated semantic failures reject inside `run_code`, rather than
resolve as ordinary values. Host-owned evidence remains authoritative.**
This intentionally changes script control flow for the selected negative paths.
It is not the halted Stage 2 conversion from JSON strings to native objects:
successful returns keep their existing representation.

A sequence awaiting each action should stop at the first designated failure
unless its script explicitly handles it. Scripts may still use catch or
all-settled control flow to continue; their handling cannot erase host receipts.
An exception is an explicit failure signal, not an uncatchable enforcement
mechanism or proof that the user request was fulfilled.

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
- Proposed first failure-contract candidates: `configure_task_check_in` and
  `cancel_run`, the two existing receipt-covered tools. Their executor evidence
  must be audited before finalizing non-application versus uncertain-effect
  labels. Existing receipt coverage alone is not sufficient proof.
- Other resolved semantic-error values enter scope only through an explicit,
  reviewed per-tool contract. The candidate list is an open inventory item;
  this draft does not authorize adapters for the entire catalog.
- Existing outer-call recovery statuses, direct tool return representations,
  approval ownership, provider continuation, and execution limits are unchanged.

Non-goals: inferring intended/omitted actions or correct targets; automatic
retries, rollback, exactly-once execution, generic throwing on an `error` key,
a new workflow DSL, and reviving Stage 2. No live receipt-pilot result proves
that all tools need the same outcome schema.

## Proposed rejection policy

This table defines the candidate treatment, not current behavior. It applies
to the selected tools only, host-classified before result serialization.

| Observed signal | Script-facing result | Host evidence |
| --- | --- | --- |
| Recognized positive executor acknowledgement | Resolve the original value | Preserve the tool-specific receipt; cancellation acceptance is not settlement |
| Recognized negative acknowledgement proving non-application | Reject | Preserve `not_applied` and its bounded reason |
| Negative acknowledgement without proof that no effect occurred | Reject | Preserve failure signal separately from unknown effect state |
| Unexpected/unparseable action acknowledgement | Reject as an unrecognized outcome | `unknown`, not a fabricated negative or safe-to-retry signal |
| Executor exception after dispatch | Existing rejection behavior | Execution failed; effect certainty depends on evidence, not the exception alone |
| Result delivery fails after a recognized applied acknowledgement | Existing rejection behavior | Keep applied evidence and separately report delivery failure |
| Legitimate empty/negative query result outside the selected set | Existing result unchanged | Do not classify it as action failure |

For `cancel_run`, the inspected return contract is the JSON string union in
`createCancelRunToolDefinition`: positive `ok`, non-empty `runId`, and
`status:cancelling`; or negative `ok`, `code:not_active`, and non-empty `target`.
A missing/inactive target remains non-application under the current cancel
operation; it is not silently reinterpreted as an ensure-stopped success.

For `configure_task_check_in`, `createConfigureTaskCheckInToolDefinition`
returns `ok:false,error` for both callback-reported negatives and caught callback
exceptions. That representation loses provenance. The existing receipt adapter
maps boolean false to non-application, but Stage 3 must not treat a caught
exception as proof of no effect. Before implementation, either establish a
trusted distinction at the owner or conservatively classify ambiguous negative
responses as uncertain effects. Do not reconstruct provenance by matching
English error text. This is a concrete readiness blocker, not another user
product decision.

Use the existing host-private classification/receipt owner as the decision
source; do not first throw locally and let a broad executor catch overwrite the
semantic result. Both auto-approved and nested-approval paths must apply the
same policy exactly once. Existing admission and execution limits stay intact.

### Catchable error contract and compatibility

The current `namespaceBinding` in `host-worker.ts` constructs a realm-local
Error from the host namespace failure envelope. It currently exposes a string
message, not a typed semantic-error object. The final spec must choose whether
that envelope carries additional bounded discriminants before promising
script-visible fields. Scripts must be able to distinguish non-application
from unknown effect without parsing natural-language prose; any new metadata
must cross by serialized data and be constructed in the sandbox realm. No
host Error instance, prototype, or constructor may cross that boundary.

Successful JSON strings remain strings; no automatic JSON parsing is introduced.
Direct-call return behavior and unrelated nested tools remain unchanged.
Scripts that currently parse a negative JSON string will instead need to catch
the rejection or use all-settled handling. Update the selected tools
`scriptedReturnShape`, discovery/describe wording, and behavioral examples with
the implementation; do not advertise the treatment before it ships. No generic
require-success helper, persistent compatibility switch, or automatic retry is
part of this slice.

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
   observations. A caught semantic rejection must retain the same host evidence
   as an uncaught one; no catch path may upgrade the action to applied.
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

## Guard contract for implementation review

- Harm prevented: a resolved semantic failure flowing through success-only
  script continuations as though the requested operation applied.
- Class: semantic contract validation at the namespace-result boundary, not
  a runtime budget, inactivity detector, or authority change.
- Enforcement owner: the existing nested `run_code` host adapter; the sandbox
  binding delivers the rejection. Recovery owner: existing script/host lifecycle
  settlement plus host-owned receipts, not a new retry coordinator.
- Signal: reviewed raw executor acknowledgements before serialization. Known
  negatives are direct failure evidence; malformed output establishes only an
  unrecognized contract, not whether the effect happened.
- Legitimate counterexamples: expected absent targets, already-satisfied
  operations, empty query results, and successful effects with unexpected
  acknowledgements. Preserve their distinct semantics and test deliberate
  catch handling. Do not treat an ensure-style no-op as failure by convention.
- Action: reject the affected nested promise. No new abort/kill policy, sibling
  cancellation, retry, fallback, or provider-continuity change. An unhandled
  rejection can still terminate the outer script under existing rules; remaining
  work must be accounted for rather than claimed rolled back.
- Configuration: no new thresholds, clamping, override precedence, persistent
  setting, or migration proposed. Existing execution/display bounds remain.
- Observability: call identity, tool, outcome provenance, failure category,
  dispatch/delivery phase, and effect certainty. Exact typed fields and
  consumers are open implementation blockers; do not log whole executor payloads.
- Preservation: earlier applied effects and artifact references remain visible;
  unknown effects cannot become automatic replay advice.
- Rollback: independently revert the semantic-rejection adapter and its
  script-facing declarations while preserving the merged receipt baseline.
  Do not couple rollback to Stage 2 or removal of evidence safeguards.
- Ledger: no runtime guard changed in this draft. Review the full
  `guard-ledger.md` and add the candidate row with source-backed ownership and
  red evidence before implementation; no verified-safe status is claimed here.

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
counts and preserved evidence. Assert the intentional resolve-to-reject change
on designated negative paths, unchanged successful return values, catch and
all-settled behavior, and unchanged unrelated tools/direct-call results. Verify
legitimate empty/negative reads. In concurrent scripts, one rejection must not
be described as cancelling or rolling back siblings; already-dispatched siblings
retain their own settlement evidence under existing lifecycle rules.

Use focused baseline/red-green tests, related tests per production file,
typecheck, changed tests, and the isolated full suite at handoff. Shared host,
run-loop, or provider changes require their additional documented gates.

Before implementation acceptance, run a preregistered paired live comparison
across Luna, GLM 5.3 Flash, and DeepSeek V4 Flash. Resolve and confirm exact
routes/effort for that run; the earlier six-cell probe is not this stage gate.
Use native tool-result continuation or an equivalent production-path fixture,
not merely a user-message quotation. Models must author and execute scripts
against each arm so the comparison exercises rejection/catch behavior, not
just the final rendering. Compare current merged behavior against the selected
failure-contract treatment, keeping success-return representations fixed.
Include expected negative outcomes, mixed outcomes, caught failures, and
uncertain effects as well as a successful control. Freeze scenarios, sample count, cost
limits, and stopping rules before paid execution.

Primary measures: false completion claims, unnecessary mutation replay, and
correct uncertainty/partial-completion reporting. Secondary measures: recovery
turns, tool calls, prompt/output tokens, latency, and context added. A correctness
regression blocks advancement; an improvement claim needs observed behavioral
benefit, not receipt-text presence. Do not erase a failed cell by retrying it.

## Next decisions

- **Settled by user:** specify the script-facing failure-contract alternative
  and type-checked TypeScript support. No further product choice is needed to
  investigate these drafts; the proposed 3A/3B split separates their contracts
  and measurement gates.
- **Engineering investigation:** settle the smallest affected tool/path set,
  output layout, consumer semantics, reused record ownership, catchable error
  discriminants, and check-in negative-result provenance from code.
- **Before live execution:** finalize the reviewed protocol and model routes.
  No paid measurement or broader implementation is implied by this draft.
