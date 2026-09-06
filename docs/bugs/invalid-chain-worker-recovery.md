# Invalid chained worker recovery investigation

Status: stale recovery-deadline failure reproduced and repaired (`700df65c`,
merged in `6d9648b1`). The provider
rejection itself remains externally unexplained; see the distinction below.

## Recovery episode repair contract (2026-09-06)

The parent reproduced the terminal Invalid previous_response_id failure by adding
900,000ms of fake elapsed time after an earlier recovery to the real runtime
characterization. The immediate case passes; the delayed case throws the exact
provider error and never reaches the expected full-history replacement.

Harm prevented: productive worker runs losing recovery after an old failure.
Scope: root and subagent requests through ApplicationRunLoop and both session
recovery handlers. Class: recovery containment, not a total-run budget.
Enforcement owner: RetryRecoveryBudget; recovery/settlement owner unchanged.
Signal: consecutive failed dispatches since the last accepted terminal model
response. Completion is direct evidence that recovery succeeded; partial tokens,
tool output, and an incomplete/failed stream are not.
Configuration: unchanged internal defaults, 90,000ms / 3 physical recovery
attempts / 1 automatic replay; constructor overrides remain test-only.
Action: reject exhausted episodes as before; accepted terminal completion ends
the episode. This intentionally supersedes the old per-logical-turn lifetime.
Separate run-budget containment remains in force across successful responses.
Partial-work settlement, cancellation, committed-output safety, and full-history
chain repair are unchanged. No persisted settings or migration.
Observability: retry.recovery_admission retains counters, deadline and settlement
evidence without payloads. Rollback: episode method and its single run-loop
completion call; diagnostics are independent. Ledger: retry/recovery containment.

Red command: pnpm test source/services/session/subagent-connect-close-retry.test.ts
(2 pass, delayed case fails with Invalid previous_response_id).

## Incident evidence

The retained provider trace for worker `ember-hedge-938` shows a Codex
Responses WebSocket request sent with `previous_response_id` set to a response
ID returned by the immediately preceding successful request. The provider
returned HTTP 400 `Invalid previous_response_id` before any response event or
frame. Application logs then show stream failure, chaining disabled, and stream
error, with no subsequent worker request. The predecessor response was present
in the retained trace; this is not explained by an absent predecessor.

The exact failed request was `b0e22a3e-ba2a-418d-b6e0-328edb3a6351` at
`03:14:43.242Z`; its predecessor was request
`8dd7716d-dacd-4932-b31e-32803bf12bfe` at `03:14:02.025Z`, which completed with
status 200. Both requests carry the worker-specific `:subagent:ember-hedge-938`
identity. The failed request contained one `function_call_output` and no
provider response frame. The application record for the failure has
`retryAttempt: 2` and `inputItems: 106`, followed by `conversation.chaining_broken`
and no worker-owned retry envelope. A replacement worker appears later; that is
new work, not recovery of this worker's failed continuation.

This worker had already recovered at least twice earlier in the same run: a
connection interruption around `02:59:44` was followed by a full-history request,
and a WebSocket close around `03:02:09` was followed by another full-history
request. The later invalid-chain failure therefore occurred after prior retry
activity and is consistent with an exhausted or mis-accounted recovery gate,
but the logs do not record the gate's evidence or counters.

## Reproduction and conclusion

The regression now drives an actual earlier WebSocket failure through
createSessionRuntime and ApplicationRunLoop, accepts a successful tool-producing
response, and then rejects its chained continuation at either 0ms or 900,000ms.
No budget counters are seeded by the fixture. Both cases must issue a fourth,
full-history request with chaining disabled and the completed tool result intact.

Disabling only the new terminal-completion hook makes the delayed case throw
Invalid previous_response_id; the immediate case stays green. Restoring the
hook makes both green. This isolates the stale recovery clock as a sufficient
cause of the local failure to recover, rather than merely testing classification.
The old one-tool regression missed elapsed time and prior real retry activity.

The retained incident had successful model responses between recoveries and
over 12 minutes between the later earlier recovery and this failure. The old
budget has no reset: once started in that logical turn, its 90-second deadline
necessarily expires before the final request. This explains the missing local
replacement under the recorded same-turn lifetime. Historic admission counters
were not logged, so additional simultaneous refusal reasons cannot be excluded.
The provider-side reason for rejecting its own recently returned ID remains
unknown; the local fix makes that rejection recoverable after productive work.

## Diagnostic artifact shipped

`RetryRecoveryBudget.describeAdmission()` now snapshots the counters and
deadline without spending a claim. Both `InitialTurnRecoveryHandler` and
`ContinuationRecoveryHandler` emit `retry.recovery_admission` immediately before
the `retry_fresh` gate, including:

- `source`, `retryKind`, `retryCause`, `streamPresent`;
- `completedToolCount`, `allToolsCompleted`, and
  `completedPairsPresentInHistory`; and
- physical/automatic counters and limits, elapsed/deadline state, the two
  `*Allowed` booleans, `automaticReplayRequired`, and final `admitted`.

This is observability only: it does not loosen the fresh-start policy or change
the settled-tool exemption. A recurrence can now distinguish missing settlement
evidence from a physical-attempt, automatic-replay, or deadline refusal. The
new handler test verifies the denied admission record, and the budget test
verifies the snapshot is non-mutating.

## Retro

Preventable: yes. A recovery timer was scoped to a long logical turn rather than
a consecutive failure episode (latent in the documented original contract).
Representability/ownership: the budget had failure and claim operations but no
success transition. One explicit completion operation now owns that transition.
Single source of truth: the same shared object still serves both recovery
handlers and RetryingModel; no caller-local clock was added. Boundary/implicit
coupling: the run loop owns accepted terminal completion, not the wrapper
(which can finish without a terminal event). Partial output cannot end recovery.
Wrong assumption: successful work between failures was treated as recovery time.
Detection/automation: prior tests checked budget arithmetic and immediate errors
separately. The real runtime elapsed-time matrix now links them, with red proof.
Siblings checked: both session handlers, RetryingModel, TurnAttempt/factory,
ContinuationState, TurnWorkflow forwarding, AgentClient forwarding, and the
shared run loop. Root/subagent callers share the completion boundary; raw
RetryingModel intentionally cannot reset it.
Knowledge gap: the old per-turn scope was explicit but lacked a legitimate
long-worker counterexample. Observability now records actual admission claims
and non-secret pre-claim counters; snapshot predictions do not override claims.

## Verification

- Focused retry/runtime/provider tests: 43 passed before the stronger real-prior-
  failure fixture; final fixture separately passed all 3 tests.
- pnpm typecheck passed after final code and formatting.
- pnpm test:provider-black-box: 177 passed, 1 skipped.
- pnpm test: 8,053 passed, 5 failed, 3 expected failures, 2 skipped. Failures
  match the previously reported nested-approval acceptance and four file-tool
  workspace/symlink failures; the full suite is not green.
