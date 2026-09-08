# run_code host-owned action receipts

Status: implemented and merged to `main` in `3e6e222e` (2026-09-08).
Scope: `run_code` nested calls only. Distinct from the halted Stage 2
native-structured-return experiment: this unit does **not** change the
script-visible return representation of any tool.

## Problem

`run_code` product-reports action success solely from the model-authored
script's return value. A script can call an action tool, ignore (or catch and
relabel) a semantic non-application signal such as `{ok:false}`, and return
`{ok:true}`; the host then renders `Result: {"ok":true}` with no visible
counter-evidence. Promise fulfillment is transport success, not semantic
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
- Unknown targets, unparseable shapes, and calls still in flight at run
  termination resolve to `unknown`, never to success.

## Outcome mapping

Terminal outcomes: `applied` | `not_applied` | `failed` | `unknown`.

Adapter inputs are the **raw executor results**, inspected host-side before
serialization, so script catch/relabel cannot alter them.

| Tool | Raw signal | Receipt outcome |
| --- | --- | --- |
| `configure_task_check_in` | JSON string `{ok:true, …}` | `applied` |
| `configure_task_check_in` | JSON string `{ok:false, error}` | `not_applied`, reason = `error` (bounded) |
| `cancel_run` | JSON string `{ok:true, runId, status:'cancelling'}` | `applied` |
| `cancel_run` | JSON string `{ok:false, code:'not_active', target}` | `not_applied`, reason names `not_active` + target |
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
- Broader gate if shared host behavior is touched (this unit touches only
  `run-code.ts` rendering/dispatch paths plus tests and this spec).
- **Stage-level three-model live measurement remains a separate required gate
  before acceptance.** No paid/live provider runs were performed in this unit.
