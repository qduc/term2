# Mid-turn `Invalid previous_response_id` kills the turn instead of chain-recovering

Status: fixed on this branch (`fix-chain-recovery-midturn`). Root cause confirmed and reproduced; regression test in `conversation-session.lifecycle.test.ts`.

## Production evidence (2026-09-28, session `c2446a9e`, model `gpt-6-luna`, codex)

App log `~/.local/state/term2-nodejs/logs/term2-2026-09-28.log`, provider traffic
`provider-traffic/2026-09-28/13-49-02_c2446/`:

- 21:49:39 local: model response succeeded (200), issued parallel `run_code` tool calls.
- Tools completed 21:50:02 / 21:50:47 / 21:51:06 (~87 s tool phase).
- 21:51:06.955 UTC-3h=14:51:06.955Z: the mid-turn continuation request chained on the
  87-second-old response id (`resp_...49b721bca`, issued by the 21:49:39 response) and got
  **400 `Invalid previous_response_id`** on a brand-new websocket (`reused: false`),
  frameCount 0, `inputItems: 20` (chained delta).
- No recovery events fired at all: no retry presenter event, no `retry.recovery_admission`,
  no `conversation.chaining_broken`, no `stream.failed`. The error surfaced as
  `Error in sendUserMessage` (conversation-orchestrator.ts:986) and the turn died.
- Contrast: at 21:30 the same session had a ws-close-1012 chain break; recovery engaged
  correctly (`chaining_broken` + `recovery_admission` + full-history rebuild, all 200s after).
- This 400 shape recurred ~15× across many sessions/models that day; response ids issued in
  200 responses can go server-side invalid within ~80 s.

## Error shape that reaches recovery (important for repro)

The error object has **no `.status` property** (both `provider-traffic` and
`agent-client.#observeCompletion` logged `errorKind: 'unknown'`, `status: 400` only via
message parsing). Message is the raw JSON string:

```
Error: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"Invalid `previous_response_id`."}}
```

`isPreviousResponseNotFoundError` (source/services/retry/retry-error-classification.ts)
matches this via its message regex, so classification *should* yield `provider_state_rejected`
chain_recovery. The proposed repro should use this exact shape (the existing tests use
`Object.assign(new Error('Invalid `previous_response_id`.'), { status: 400 })`, a different shape).

## Designed recovery path (verified reading)

1. Mid-turn tool continuation runs inside `ApplicationRunLoop`; on the 400 it calls
   `classifyInLoopModelRetry` (source/services/retry/in-loop-model-retry.ts):
   `isPreviousResponseNotFoundError` → `recoverChain()` → because the request carries
   `previousResponseId` (run loop builds it from its own `state.responseId`),
   `requestUsedCallerChain` returns true → refuse with `'chained_delta_not_self_contained'`
   (correct: the run loop only has the delta; session recovery owns full history).
2. Error propagates to the session layer: `TurnWorkflow.executeContinuationAttempt` catch
   (turn-workflow.ts ~line 963) → `ContinuationRecoveryHandler.handle`.
3. `DefaultRetryClassifier.classify` (retry-classifier.ts): the failed stream has committed
   output (tool calls ran), so the committed-output branch applies: recovery is allowed only
   when `isSettledCommittedToolContinuation(context.committedToolContinuation)` —
   `completedToolCount > 0 && allToolsCompleted && completedPairsPresentInHistory` —
   AND the error is a connection interruption or provider-state rejection.

## Prime suspect (confirmed)

The decline point is the committed-output *admission gate* in
`DefaultRetryClassifier.classify` (`source/services/retry/retry-classifier.ts`).
Once the failed stream has committed output, recovery is admitted only when
`isSettledCommittedToolContinuation(context.committedToolContinuation)` is true —
`completedToolCount > 0 && allToolsCompleted && completedPairsPresentInHistory`.

`SessionToolTracker.inspectCommittedToolContinuation()`
(`session-tool-tracker.ts:83`) computes `completedPairsPresentInHistory` from
`getReconciledHistory()` = `projectProviderHistory(store history, ledger)`.
`projectProviderHistory` **does** insert completed ledger pairs missing from
history — *unless* the history contains a provider replacement boundary
(`lastReplacementBoundaryIndex(history) >= 0`, i.e. an OpenAI compaction item),
in which case it returns the history unchanged and inserts nothing
(`conversation-state-projector.ts:105`).

The 2026-09-28 session ran for ~1 h with many tool calls and reported the failed
request as `inputItems: 20, inputType: "array"` — a short, compacted history.
With a replacement boundary present, a completed `run_code` pair that is durable
in the ledger but sits behind the boundary is *never* inserted into the
projected request, so `completedPairsPresentInHistory` is false, `classify`
returns `unrecoverable`, and the turn terminates.

`reconcileAndUpdateHistory()` cannot repair this case: it re-runs the same
projection, which early-returns on the boundary (`changed=false` in a direct
probe). Settlement has to precede the gate, and the gate must not require the
request-scoped projection of a pair the provider boundary legitimately excludes.

The compaction-boundary trigger is *reproduced*, not read from the ledger: a
session-lifecycle test with a completed `run_code` pair behind a boundary and
the exact production error string fails exactly as production did (no
`chaining_broken`, no `recovery_admission`, turn rejected) and passes with the
fix. Which of the three evidence fields was false in `c2446a9e` is inferred from
that reproduction plus the compacted 20-item request; the fix is deliberately
class-wide (any provider-state rejection once all live-turn tools completed), so
it does not depend on identifying the exact field.

### Resolving the missing `stream.failed` anomaly

The failure *did* reach the initial recovery handler; it classified as
`unrecoverable` and yielded an `error` event. `InitialTurnRecoveryHandler` logs
`stream.failed` in `#logFailure()` **after** yielding that error event. On the
real path the adapter's `collectTerminalResult`
(`source/services/session/terminal-result-collector.ts:164-181`) throws the
moment it reads an `error` event and never pulls the next value, abandoning the
handler generator before `#logFailure` runs. So: no `stream.failed`, no
`chaining_broken`, no `retry.recovery_admission`, and the error surfaces at the
orchestrator as `Error in sendUserMessage`. That is why every recovery log line
was absent rather than a different propagation path.

`#continuePostExecuteRun` was also checked. It *does* bypass recovery entirely
(its catch rethrows without calling the recovery handler), which reproduces the
same symptom for a failure that arrives while a post-execute gate holds the live
run. It is a real but separate gap: it is reachable only after a post-execute
pause (the denied-read shell gate), and it is driven through
`handleApprovalDecision`/`continueAfterPostExecuteApproval`, not
`sendUserMessage`. Left unfixed here to keep this change scoped; see
"Residual gaps" below.

## Fix

A provider *state* rejection (`Invalid previous_response_id`,
`previous_response_not_found`, missing/orphaned chained tool output) is not a
replay: the server refused the chained request before accepting anything, and
`chain_recovery` rebuilds from durable full history without re-running a
completed tool. The only thing that can make it a replay is an open/unknown
tool call, which `allToolsCompleted` / `completedToolCount > 0` still guard.

- `committed-tool-continuation.ts`: added `admitsProviderStateRejectionRecovery`
  — `completedToolCount > 0 && allToolsCompleted`, no request-scoped
  `completedPairsPresentInHistory` requirement. `isSettledCommittedToolContinuation`
  is unchanged, so the connection-interruption path and `skipsAutomaticReplayClaim`
  keep their existing (stricter) rule.
- `retry-classifier.ts`: the committed-output branch admits a provider-state
  rejection via the new predicate, in addition to the existing settled-evidence
  path.
- `initial-turn-recovery-handler.ts` / `continuation-recovery-handler.ts`: call
  `toolTracker.reconcileAndUpdateHistory()` before `inspectCommittedToolContinuation()`
  so completed pairs are settled into history before the decision (settle-then-recover).

The partial history is unaffected: boundary-orphaned pairs stay out of the
request (the projector still refuses to insert them behind the boundary), and no
tool is re-executed.

## Residual gaps

- `TurnWorkflow.#continuePostExecuteRun` (`turn-workflow.ts:741`) rethrows a
  live-run failure without consulting `ContinuationRecoveryHandler`, so the same
  400 is still fatal when it surfaces on a post-execute-gated live run. Separate
  fix; not exercised by the production turn (which escaped `sendUserMessage`).
- `collectTerminalResult` throws on the first `error` event and abandons the
  producing generator, so post-error logging/cleanup in the recovery handlers is
  skipped. Not changed here; noted because it is what made the original bug
  invisible to logs.

## Tests

- `conversation-session.lifecycle.test.ts` — "chain-recovers a mid-turn tool
  continuation that fails with Invalid previous_response_id after every
  live-turn tool completed" (session-lifecycle regression; fails without the
  fix, passes with it).
- `retry-classifier.test.ts` — provider-state rejection after every live-turn
  tool completed is admitted even when a compaction boundary keeps the durable
  pairs out of the projected request; a not-completed live-turn tool is still
  refused.
- `committed-tool-continuation.test.ts` — pins
  `admitsProviderStateRejectionRecovery`.

## Relevant prior art

- docs/plans/chain-settlement.md (read it; its Premises and the 2026-08-30 model-switch
  section define the invariants; update its status if behavior changes)
- Existing coverage: retry-classifier.test.ts:415, continuation-recovery-handler.test.ts:32,
  initial-turn-recovery-handler.test.ts:29, conversation-session.lifecycle.test.ts:816,
  application-run-loop.test.ts:3551, codex-responses-model.test.ts:3760-4263
