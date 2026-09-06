# Invalid chained worker recovery investigation

Status: incident mechanism narrowed; the settled-tool recovery policy is present
in the baseline, but the retained production records do not show why admission
did not produce a replacement worker request. Recovery admission is now
instrumented in both session recovery handlers; the incident cause remains
unproven because it predates that instrumentation.

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

## Reproduction status

`source/services/session/subagent-connect-close-retry.test.ts` contains a
deterministic session/run-loop characterization. It starts a subagent runtime
with fresh-start retries disabled, executes a worker tool, rejects the next
chained request with the same provider-state error before yielding a frame, and
verifies a third request is full-history with chaining disabled and the
completed tool result present. It also pre-spends the shared automatic replay
claim, reproducing the long-turn budget state. The test passes on the baseline;
removing the settled-tool exemption makes it terminate after the 400 instead of
issuing request three. This proves the policy in that runtime, not that the
production `run_subagent` worker uses this recovery owner.

The focused command is:

```text
pnpm test source/services/session/subagent-connect-close-retry.test.ts -t "recovers a stale chained worker continuation"
```

It passes deterministically. The same scenario is red against the pre-settled-
tool recovery policy: the prior automatic replay claim causes the recovery
budget gate to terminate unless `isSettledCommittedToolContinuation` permits
the chain recovery without claiming that slot. This is the real-path evidence,
not a classifier-only mock.

## Current hypotheses

1. **Highest-confidence mechanism:** the app classified the 400 as
   `retry.conversation_state` with `retryAttempt: 2`, broke chaining, then
   emitted no second worker request. The session-level admission point is the
   recovery handler's `retry_fresh` budget gate: it requires a physical attempt
   and, unless the continuation is proven settled, an automatic-replay claim.
   The real-path characterization proves that a previously spent
   automatic-replay claim is safe to bypass only when all live tools are
   completed and their pairs remain in reconciled history.
2. The retained incident logs do not include the three admission booleans
   (`completedToolCount`, `allToolsCompleted`, `completedPairsPresentInHistory`)
   or the budget counters, so they cannot distinguish “settled evidence was
   false” from “automatic replay, physical-attempt, or deadline budget was
   exhausted.” The trace proves the provider rejected the chained request; it
   does not by itself identify which recovery-admission boolean was false.
3. The running process loaded `dist/` (the failure stack is under
   `/home/qduc/term2/dist/`). Current source and current `dist` contain the
   settled-tool exemption. The incident behavior therefore requires either a
   different recovery owner in the production `run_subagent` path, failed
   settlement evidence, or a budget/admission rejection. A stale build is only
   one deployment hypothesis, not proof of which artifact was loaded at
   `03:14:43`.
4. The provider-side reason for rejecting a response ID remains unknown beyond
   the recorded 400. The predecessor ID was valid in the immediately preceding
   success, so “missing predecessor” is ruled out.

No secrets or prompt bodies are recorded here.

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

- **Preventable:** yes. The failure crossed a provider/session boundary, but
  admission state was not recorded at the point that decided whether to issue
  the replacement request.
- **Bug and root cause:** a worker continuation received a provider-state 400,
  then no replacement worker request was observed. The local cause is known only
  to the boundary: the retained records show chain break and termination, not
  whether settlement evidence or a recovery budget gate refused admission.
- **Detection gap:** the existing characterization exercised the session
  runtime with a fake client and proved policy behavior, but the production
  worker trace had no admission evidence. It therefore could not distinguish a
  policy defect from a different owner or an exhausted/mis-accounted gate.
- **Hardened:** the shared budget exposes one typed, non-mutating admission
  snapshot and both recovery owners log the same decision inputs. The exact
  production owner and the provider's reason for rejecting the predecessor
  remain open questions; no causal claim is made here.
