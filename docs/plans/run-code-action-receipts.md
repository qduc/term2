# run_code host-owned action receipts

Status: original implementation merged to `main` in `3e6e222e`; bounded review
repair validated locally and with a three-model continuation probe (2026-09-08).
See [Bounded review repair](#bounded-review-repair) for evidence and limits.
Scope: `run_code` nested calls only. Distinct from the halted Stage 2
native-structured-return experiment: this unit does **not** change the
script-visible return representation of any tool.

## Problem

`run_code` product-reports action success solely from the model-authored
script's return value. A script can call an action tool, ignore (or catch and
relabel) a semantic non-application signal such as `{ok:false}`, and return
`{ok:true}`; the host then renders `Result: {"ok":true}` with no visible
counter-evidence in the pre-receipt implementation. Promise fulfillment is transport success, not semantic
success: both `configure_task_check_in` and `cancel_run` resolve normally
(JSON strings) when the action semantically did not apply.

Regression rationale: the nested dispatch in
`source/tools/system/run-code/run-code.ts` records only transport/policy
outcome per call (`RunCodeCallRecord.outcome`: `ok`/`error`/`approval_required`/…).
`SchemaToolDefinition.effect: 'mutating'` is a stall-detection marker, not a
semantic action contract, so it cannot drive this. The semantic outcome must
therefore be derived in `run_code`'s trusted host side from the raw executor
result, on a per-tool-classified basis, and rendered by the host next to —
and authoritatively above — the script's own claim.

## Scope (exact)

Covered tools (static host-owned set, exactly these two):

- `configure_task_check_in`
- `cancel_run`

Non-goals, explicitly out of scope:

- Any tool not listed above. This spec must not be read as applying to other
  tools; extending the set is a follow-up unit with its own adapter review.
- Wrong-target and omitted-action detection (the script configuring/cancelling
  a valid-but-unintended target, or never calling the action at all). The
  ledger aggregates **only observed action receipts**; an empty ledger renders
  no action section and must never certify fulfillment.
- Native structured returns (halted Stage 2 experiment). Raw script-visible
  action returns are preserved exactly as before.
- A generic auto-throw helper or a declarative action planner. Adapters are
  explicit per-tool functions, not conventions, script declarations, or the
  generic `effect` flag.

## Guarantee / non-guarantees

Guarantee: for every observed nested call to a covered tool, the host renders
a receipt with a stable call identity, the tool name, a terminal outcome, and
a bounded reason where appropriate — even when the script catches, swallows,
or contradicts the underlying signal. The host-derived outcome is worded as
authoritative over conflicting script `{ok:true}` claims.

Non-guarantees:

- The receipt says what the executor reported/did, not what the user wanted.
  Summary wording must never phrase outcomes as user-request or task success
  (e.g. never "task muted", "cancellation complete").
- `applied` for `cancel_run` means cancellation was *requested and accepted*
  (`{ok:true, status:'cancelling'}`); settlement arrives separately through
  the normal completion path.
- Recognized negative executor responses, including missing/inactive targets,
  resolve to `not_applied`. Unparseable or unexpected shapes and calls still
  in flight at run termination resolve to `unknown`, never to success.

## Outcome mapping

Terminal outcomes: `applied` | `not_applied` | `failed` | `unknown`.

Adapter inputs are the **raw executor results**, inspected host-side before
serialization, so script catch/relabel cannot alter them.

| Tool | Raw signal | Receipt outcome |
| --- | --- | --- |
| `configure_task_check_in` | JSON string `{ok:true, …}` | `applied` |
| `configure_task_check_in` | JSON string `{ok:false, error}` | `not_applied`, reason = `error` (bounded) |
| `cancel_run` | JSON string `{ok:true, runId, status:'cancelling'}` with non-empty string `runId` | `applied`, reason distinguishes accepted request from settlement |
| `cancel_run` | JSON string `{ok:false, code:'not_active', target}` with non-empty string `target` | `not_applied`, reason names `not_active` + target |
| either | unparseable / unexpected shape | `unknown`, reason `unrecognized action result shape` |

Lifecycle mapping (all captured, none silently omitted):

| Event | Receipt outcome |
| --- | --- |
| Parameter validation failure (`invalid_params`) | `failed`, reason carries validation detail |
| Authority denial at prepare (path authority) | `not_applied`, reason carries denial |
| Approval/policy denial (`approval_required`, `unknown_policy`, `policy_error`, `interceptor_denied`, nested-approval denial) | `not_applied`, reason names the denial kind |
| Executor throw / nested-approval `failed` | `failed`, reason carries the error message |
| Call admitted but not settled when the run terminates (timeout, deadline, cancellation, worker exit) | `unknown`, reason `did not settle before the script run ended` |
| Call-budget rejection after prepare (`overBudget`) | `unknown`, reason `call budget exhausted before dispatch` |

Reasons are bounded (truncated, currently 280 chars) text only.

## Lifecycle / settlement policy

- The ledger is host-private, created per `run_code` execution. Script code
  has no write path to it: receipts are recorded in `prepare` short-circuits,
  the `onAdmitted` hook (pending `unknown` entry keyed by stable admission
  `callId`), and the `invoke` settlement paths (policy, nested-approval, and
  auto-approve branches). The sandbox host supplies `overBudget` the exact
  prepared call it rejected; receipt attribution does not depend on a local
  FIFO because asynchronous preparation can overlap. Script code may continue
  returning arbitrary values.
- Stable call identity: admitted calls use `<bridgeRunId>:<callId>` (the same
  `callId` the host passes to `invoke`, stable across concurrency);
  pre-admission rejections use `<bridgeRunId>:rejected-<seq>`.
- After the sandboxed run settles, pending entries are finalized to the
  unsettled wording above. `Promise` fulfillment alone is never mapped to
  `applied`; only the adapter table maps a resolved value to `applied`.
- Rendering is additive: the existing `Result:`/failure/console/policy/`[call
  summary]` sections are unchanged, and observation-only scripts (no covered
  calls) render byte-identical output to before. When the ledger is non-empty,
  the host appends an `Action outcomes (host-observed, …)` section that states
  the per-tool outcomes, an honest aggregate (counts of applied / not applied
  / failed / unknown, naming mixed and unknown cases as such), and one line
  declaring host observations authoritative over conflicting script claims.
- The existing 30,000-character final display bound must preserve host evidence.
  On overflow, save the complete output through the existing artifact owner and
  reserve visible space for the action section before clipping script output.
  If the ledger itself cannot fit, show its aggregate and authority statement
  with an explicit count of omitted receipt details. The full artifact retains
  all receipts; storage failure must disclose that omitted details are unavailable
  without hiding the aggregate or inviting replay. Short and observation-only
  output retains its existing rendering. This qualifies the per-call rendering
  guarantee: individual receipts may require artifact retrieval on overflow.

## Regression coverage

Focused behavioral tests in
`source/tools/system/run-code/run-code-action-receipts.test.ts` assert public
rendered-result behavior (not private ledger state):

1. Ignored semantic `ok:false` + script `{ok:true}` claim → receipt
   `not applied`, host section present alongside the script claim.
2. `cancel_run` `{ok:false, code:'not_active'}` → `not applied`.
3. Caught/handled executor throw + script success claim → `failed` receipt.
4. Approval/policy denial → `not applied` + existing `Refused` notice intact.
5. Multiple mixed outcomes in one script → honest aggregate naming both.
6. Call in flight at script timeout → `unknown` unsettled wording.
7. Observation-only script → no action section (legacy behavior preserved).

## Acceptance gates

- Focused tests, `pnpm test:related` per changed production file,
  `pnpm typecheck`, `pnpm test:changed`, formatting/diff check green.
- The original merge also changed shared `sandboxed-code-host.ts` and
  `host-types.ts` admission hooks. The isolated full suite (`pnpm test`) is
  therefore the broader gate; focused receipt tests alone do not close it.
- Stage-level three-model live measurement is separate from deterministic
  rendering tests. The original merge had no live evidence. The bounded repair
  now has the paired reporting/replay probe linked below; its scope is overflow
  evidence consumption, not the complete lifecycle or cancellation matrix.

## Bounded review repair

The follow-up preserves the two-tool scope and script-visible returns; no
new receipt framework, provider route, execution budget, or persisted setting.
Baseline: focused suite passed 7 tests. Ten added regressions failed before
production edits and then passed (17 total): malformed cancellation signals,
large result/console/error text, and a ledger exceeding the display bound with
and without artifact storage. Verification completed:

- Focused: 17 passed (2.12 s).
- Related and changed gates: each 47 files, 966 passed, one expected failure
  (23.84 s and 23.15 s). Typecheck, source Prettier check, and diff check passed.
- Isolated full suite: 628 files passed, one skipped; 8,450 tests passed,
  three expected failures and four skips (149.06 s). The combined validation
  command exited 0 after 216.22 s, within its explicit 900,000 ms allowance.
- The first related run failed the documented nested-TMPDIR approval fixture
  (`seen=[]`). The same gate passed with `TMPDIR=/tmp`; all subsequent test
  gates used that environment. No test or production workaround was added.
- [Live continuation probe](../reports/run-code-action-receipts-live-2026-09-08.md):
  all three baseline cells falsely reported success; all three repaired cells
  correctly reported non-application. No action replay occurred in either arm.
  This is one supplied-evidence continuation pair per model, not a native
  resumed-session benchmark or a population reliability estimate.

Detection gap: the original tests used small script outputs and well-formed
executor payloads. Receipt placement was implicitly coupled to generic prefix
clipping, and the cancellation adapter treated a boolean as the full contract.
The public-boundary overflow matrix and explicit accepted/negative shape checks
protect these classes without a new abstraction. The sibling check-in adapter
uses its documented boolean discriminator; observation-only overflow retains
its existing artifact and storage-failure tests.
