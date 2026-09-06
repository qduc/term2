# Invalid chained worker recovery investigation

Status: diagnosed and characterized; source behavior is already repaired in the
baseline, so this worktree adds a real-path regression characterization rather
than changing retry policy.

## Incident evidence

The retained provider trace for worker `ember-hedge-938` shows a Codex
Responses WebSocket request sent with `previous_response_id` set to a response
ID returned by the immediately preceding successful request. The provider
returned HTTP 400 `Invalid previous_response_id` before any response event or
frame. Application logs then show stream failure, chaining disabled, and stream
error, with no subsequent worker request. The predecessor response was present
in the retained trace; this is not explained by an absent predecessor.

## Reproduction status

`source/services/session/subagent-connect-close-retry.test.ts` now contains a
deterministic real session/run-loop characterization. It starts a subagent
runtime with fresh-start retries disabled, executes a worker tool, rejects the
next chained request with the same provider-state error before yielding a
frame, and verifies a third request is full-history with chaining disabled and
the completed tool result present. It also pre-spends the shared automatic
replay claim, reproducing the long-turn budget state. The test currently passes
on the baseline; removing the settled-tool exemption would make it terminate
after the 400 instead of issuing request three.

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
   settled-tool exemption, while the incident behavior matches a build from
   before that exemption or a runtime whose tracker failed to prove settlement.
   This is a deployment/version hypothesis, not proof of which artifact was
   loaded at 03:14:43.
4. The provider-side reason for rejecting a response ID remains unknown beyond
   the recorded 400. The predecessor ID was valid in the immediately preceding
   success, so “missing predecessor” is ruled out.

No secrets or prompt bodies are recorded here.
