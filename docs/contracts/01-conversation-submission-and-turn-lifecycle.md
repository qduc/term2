# Contract 01 — Conversation submission and turn lifecycle

Status: **owner-reviewed 2026-08-14; focused command green.**

## 1. Contract

| # | Invariant | User-visible harm it prevents |
| --- | --- | --- |
| C1.1 | A submission has stable identity from admission through terminal settlement. | Lost or misattributed requests: a turn settles under a different identity than the user submitted, or two submissions collide and one is silently overwritten. |
| C1.2 | Queued, activating, active, awaiting-approval, continuing, and terminal states cannot be mistaken for one another. | UI shows a running turn as queued (or vice versa); approvals are routed to the wrong turn; a stale holder mutates a newer turn's status. |
| C1.3 | Every accepted request promise settles exactly once on success, rejection, removal, cancellation, recovery, or failure. | Callers (UI submit flows) hang forever on a promise that never settles, or double-settle corrupting the store. |
| C1.4 | UI pending and active projections follow domain events and cannot keep a settled request visible as queued or running. | Ghost pending rows: a request that settled still appears queued/running, so the user believes work is outstanding when it is not. |
| C1.5 | A steer belongs to a declared turn until its next request boundary, or is truthfully admitted as a separate queued turn; stream-segment gaps cannot silently drop it. | User input typed during gaps (before first request, retry backoff, approval pause, compaction) vanishes, or the caller waits forever on a steer the run never reached. |

## 2. Owners

- **Enforcement:** `QueueController` (queue admission and queue-item state);
  `ConversationAdapter` (request identity, executable payload routing, promise
  settlement); `TurnStatusMachine` (turn status legality); `TurnCoordinator`
  (turn admission and delegation); `ApplicationRunLoop` (steer admission and
  request boundaries); `ConversationOrchestrator` (projection onto UI).
- **Recovery:** `ConversationAdapter` settlement paths (`retractSubmission`,
  `discardQueue`, cancel); `TurnCoordinator.abort` (+ `providerContinuity.clear`);
  `ApplicationRunLoop` steer release/settle on abort and turn close;
  `ConversationOrchestrator` pending-row retirement when start observers are
  skipped.

## 3. Execution paths that share the contract

- Immediate execution (queue idle, no turn in flight) — direct append and
  immediate start.
- Deferred queue execution (turn busy) — enqueue, queued-start observer, turn
  start.
- Steer during an active turn — held as pending steer until the request
  boundary or released at turn end.
- Repeated approval continuations (`awaiting_approval -> continuing -> ...`).
- Retry/recovery — retry before stream start; recovery after partial stream
  output.
- UI projection — start callbacks delayed, skipped, or replayed.

## 4. Identities and state crossing the boundary

- `requestId` (adapter, generated from `preferredMessageId` or a counter) is
  also the queue `ItemId` and the display id of the pending row
  (`conversation-adapter.ts:492-496`, `:86-89`).
- Queue snapshot carries only `{ requestId, recovered? }`; the adapter resolves
  the executable payload from `#messagesById` at start (`:227-235`).
- Branded identities `ItemId`, `ExecutionId`, `ActionId`
  (`queue-controller.ts:1-3`).
- Turn lease: `beginTurn` returns a lease; only the owning lease may
  `requestApproval`/`complete`; stale leases are no-ops
  (`turn-status-machine.ts:46-84`, test `turn-status-machine.test.ts:140-151`).
- Approval decisions cross the adapter to turn boundary with staleness/epoch
  checks (`conversation-adapter.test.ts:124`, `:168`, `:212`).
- Durable identity: `assistant_turn` and journal items carry `turnId` with a
  per-turn `seq` (`conversation-log-events.ts:157-186`, `:276-289`).

## 5. Settlement semantics

- **Success:** `#runQueuedTurn` emits queue `completed` and resolves the
  `sendMessage` promise via `#settleSuccess` (`conversation-adapter.ts:616-648`).
- **Rejection:** admission reject or command exception -> `#settleFailure` and
  map entry removed (`:517-529`); typed `QueueCommandResult` rejection reasons
  `'capacity' | 'invalid' | 'not_queued' | 'stale' | 'inapplicable'`
  (`queue-controller.ts:147-150`).
- **Removal:** `retractSubmission` -> `AbortError("Queued message was removed")`;
  `discardQueue` -> `AbortError("Queued message was discarded")` per queued id
  (`:402-409`, `:540-549`).
- **Cancellation:** active cancel -> `AbortError("Active turn was cancelled")`
  when the adapter still retains the request (`:552-579`); queue controller
  ignores late terminal events after cancellation
  (`queue-controller.test.ts:215`).
- **Retry/recovery:** before stream start -> `retry_fresh` with full history
  (`recovery-policy.test.ts:39`); after partial stream output -> retry without
  committing failed stream history (`conversation-session.stream.test.ts:103`,
  `:279`).
- **Ambiguous/stale:** stale approval decision after a later continuation is
  ignored (`conversation-orchestrator.test.ts:523`); `TurnOutcome.kind: 'stale'`
  emits nothing and does not call `complete()`
  (`turn-status-machine.ts:86-101`; `docs/plans/turn_coordinator_refactor.md:459-464`).

## 6. Observability

- Structured logs: `"Submission routing decided"` (`conversation-orchestrator.ts:572-586`),
  `"Steer attempt resolved"` (`:599-627`), `"Steer released at run end"`
  (`application-run-loop.ts:506-514`), `"Steer admitted at request boundary"`
  (`:523-539`), `"queuedTurnStartObserver threw"` (`conversation-adapter.ts:587-599`),
  `"sendMessage received final event"` (`:735-757`).
- Durable events: `user_message` (with UI message id), `tool_started`,
  `tool_result` (status `completed|failed|aborted|unknown`), `approval_required`
  / `approval_resolved`, `assistant_turn` (`conversation-log-events.ts:69-113`,
  `:276-289`).
- Diagnosis: a stuck request is visible as a pending row with no matching
  `user_message`/`assistant_turn` settlement, or a promise pending past turn
  end; the adapter logs mark the routing decision and final-event return.

## 7. Public boundary under test

- `QueueController.command()/state()` — `queue-controller.test.ts`.
- `ConversationAdapter` public ops — `sendMessage`, `retractSubmission`,
  `editSubmission`, `steerActiveTurn`, `handleApprovalDecision`, observer
  registration — `conversation-adapter.test.ts`.
- `ConversationOrchestrator` via UI callbacks — `conversation-orchestrator.test.ts`.
- `ApplicationRunLoop.steer/retractSteer/editSteer/openTurn/closeTurn/abort` —
  `application-run-loop.test.ts`.
- `TurnCoordinator.start/continueAfterApproval` and `TurnStatusMachine`
  transitions — `turn-coordinator.test.ts`, `turn-status-machine.test.ts`.

## 8. Deterministic contract matrix

| ROADMAP minimum-matrix cell | Evidence (file:title) | Status |
| --- | --- | --- |
| Immediate execution | `queue-controller.test.ts:13` "admits FIFO work with an immutable dispatch snapshot and starts only one execution"; `conversation-orchestrator.test.ts:593` "appends directly when queue is wired up but no turn is in flight" | covered |
| Deferred queue execution | `conversation-orchestrator.test.ts:636` "does not begin an owned turn for deferred queue work until the queue starts it"; `queue-controller.test.ts:60` "holds completion admission while submissions enqueue, then dispatches the next item exactly once" | covered |
| Remove before start | `conversation-adapter.test.ts:1262` "retractSubmission removes a queued item by id and settles its sendMessage promise"; `conversation-orchestrator.test.ts:671` "does not end a turn when deferred queue work is removed before it starts" | covered |
| Edit before start | `conversation-adapter.test.ts:1145` "editSubmission on a queued item sends the edited text"; `:1193` "rolls back #messagesById when the controller rejects the edit" | covered |
| Cancel with zero retained items | `queue-controller.test.ts:250` "manual cancel with no retained queue returns to idle"; `:1015` (cancel from awaiting action, zero retained) | covered |
| Cancel with one retained item | `queue-controller.test.ts:215` "awaits cancellation cleanup, ignores late terminal events, and retains queued items paused manually" | covered |
| Cancel with multiple retained items | `queue-controller.test.ts:250` "manual cancel retains multiple queued items and resumes them FIFO" | covered |
| Repeated approval continuations | `turn-coordinator.test.ts:237` "awaiting_approval -> continuing -> awaiting_approval"; `conversation-session.characterization.test.ts:1117` "multiple sequential interruptions preserve approval and tool-start ordering" | covered |
| Stale approval identity | `conversation-orchestrator.test.ts:523` "ignores a late approval A decision after continuation presents approval B"; adapter epoch/stale tests `conversation-adapter.test.ts:124`, `:168`, `:212` | covered |
| Retry before stream start | `conversation-session.characterization.test.ts:1326` "fresh start execution recovers from transient error with successful re-drive"; `recovery-policy.test.ts:39` "transient failure without stream produces retry_fresh with full_history" | covered |
| Recovery after partial stream output | `conversation-session.stream.test.ts:103` "run() retries streamed recoverable errors without committing failed stream history"; `:279` "emits tool_recovery before error when a streamed turn fails after tool activity" | covered |
| UI projection — start callbacks delayed | `conversation-orchestrator.test.ts:636` (unresolved `sendMessage`, manual observer dispatch; no `onTurnStart` before callback) | covered |
| UI projection — start callbacks skipped | `conversation-orchestrator.test.ts:728` "clears a delivered queue row even when the queue-start observer never fires" (regression for commit `80a48390`) | covered |
| UI projection — start callbacks replayed | `conversation-orchestrator.test.ts:813` "does not double-append when the observer fires for an already-directly-appended message" | covered |

## 9. Verification commands

Focused (verified 2026-08-14, all green):

```sh
NODE_ENV=test pnpm test \
  source/services/queue/queue-controller.test.ts \
  source/services/conversation/conversation-adapter.test.ts \
  source/services/conversation/conversation-orchestrator.test.ts \
  source/services/conversation/conversation-service.test.ts \
  source/services/agent-runtime/application-run-loop.test.ts \
  source/services/session/turn-coordinator.test.ts \
  source/services/session/turn-status-machine.test.ts \
  source/services/session/conversation-session.characterization.test.ts \
  source/services/retry/recovery-policy.test.ts \
  source/services/session/conversation-session.stream.test.ts
```

Result: **10 files / 340 tests passed.** The Phase 0 baseline command had five
valid paths, but under-covered this matrix. This command adds the turn
coordinator, status machine, continuation characterization, recovery-policy,
and partial-stream recovery boundaries.

Broader gates: `NODE_ENV=test pnpm test` (full suite, 6,205 tests green at
baseline commit), `pnpm typecheck`, and — for any provider/bridge/run-loop
change — `NODE_ENV=test pnpm test:provider-black-box`.

## 10. Known gaps and classification

All minimum-matrix cells are covered.

The Phase 0 Seam 1 command named only valid paths but under-covered this
contract; that historical scope limitation is not a product or coverage gap.
